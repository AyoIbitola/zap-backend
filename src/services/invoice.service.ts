import { prisma } from '../lib/prisma.js'
import { getRedis } from '../lib/redis.js'
import { getLightningProvider } from '../lightning/index.js'
import { LightningNodeError } from '../lightning/provider.interface.js'
import { invoicePollingQueue } from '../jobs/queue.js'
import {
  ArticleNotPublishedError,
  InvalidInvoiceTransitionError,
  InvoiceNotFoundError,
} from '../types/errors.js'
import {
  issueAccessToken,
  writeAccessTokenToRedis,
} from './accessToken.service.js'
import { enqueueInvoicePaidWebhooks } from './webhookDispatch.service.js'
import type { NodeProvider } from '@prisma/client'

function activeNodeProvider(): NodeProvider {
  const p = process.env.LIGHTNING_PROVIDER
  if (p === 'LNBITS' || p === 'LND') return p
  throw new Error(`Unknown LIGHTNING_PROVIDER: ${p}`)
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createInvoice(articleId: string, readerFingerprint: string) {
  // 1. Load article — must exist and be published
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, title: true, slug: true, priceSats: true, published: true },
  })

  if (!article || !article.published) {
    throw new ArticleNotPublishedError(articleId)
  }

  // 2. Return existing PENDING invoice if created within last 60s and not expired
  const recentPending = await prisma.invoice.findFirst({
    where: {
      articleId,
      readerFingerprint,
      status: 'PENDING',
      createdAt: { gte: new Date(Date.now() - 60_000) },
      expiresAt: { gt: new Date() },
    },
  })
  if (recentPending) {
    return {
      paymentHash: recentPending.paymentHash,
      invoiceString: recentPending.invoiceString,
      amountSats: recentPending.amountSats,
      expiresAt: recentPending.expiresAt,
    }
  }

  // 3. Create invoice on the Lightning node
  const provider = getLightningProvider()
  const memo = `Zap: ${article.title}`

  let providerResult: Awaited<ReturnType<typeof provider.createInvoice>>
  try {
    providerResult = await provider.createInvoice(article.priceSats, memo)
  } catch (err) {
    if (err instanceof LightningNodeError) throw err
    throw new LightningNodeError('LNBITS', 'createInvoice', undefined, (err as Error).message)
  }

  // 4. Persist Invoice row
  const invoice = await prisma.invoice.create({
    data: {
      articleId,
      readerFingerprint,
      paymentHash: providerResult.paymentHash,
      invoiceString: providerResult.invoiceString,
      amountSats: providerResult.amountSats,
      status: 'PENDING',
      nodeProvider: activeNodeProvider(),
      expiresAt: providerResult.expiresAt,
    },
  })

  // 5. Enqueue polling job
  await invoicePollingQueue.add(
    'PollInvoice',
    { paymentHash: invoice.paymentHash },
    { delay: 5000, attempts: 12, backoff: { type: 'fixed', delay: 5000 } },
  )

  return {
    paymentHash: invoice.paymentHash,
    invoiceString: invoice.invoiceString,
    amountSats: invoice.amountSats,
    expiresAt: invoice.expiresAt,
  }
}

// ─── Confirm (idempotent) ─────────────────────────────────────────────────────

export async function confirmInvoice(paymentHash: string): Promise<void> {
  let rawJwt: string | null = null
  let tokenHash: string | null = null
  let articleId: string | null = null
  let readerFingerprint: string | null = null
  let amountSats: number | null = null

  await prisma.$transaction(async (tx) => {
    // SELECT FOR UPDATE locks the row for the duration of this transaction.
    // Concurrent confirms on the same paymentHash will WAIT here, then read the committed
    // PAID status and return early — preventing duplicate AccessToken creation.
    const rows = await tx.$queryRaw<Array<{
      id: string; status: string; articleId: string; readerFingerprint: string; amountSats: number
    }>>`
      SELECT id, status, "articleId", "readerFingerprint", "amountSats"
      FROM "Invoice"
      WHERE "paymentHash" = ${paymentHash}
      FOR UPDATE
    `

    const invoice = rows[0]
    if (!invoice) throw new InvoiceNotFoundError(paymentHash)

    // Idempotency guard — second call after first committed reads PAID here
    if (invoice.status === 'PAID') return

    if (invoice.status !== 'PENDING') {
      throw new InvalidInvoiceTransitionError(invoice.status, 'PAID')
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', confirmedAt: new Date() },
    })

    const result = await issueAccessToken(
      tx,
      invoice.id,
      invoice.articleId,
      invoice.readerFingerprint,
    )

    rawJwt = result.rawJwt
    tokenHash = result.tokenHash
    articleId = invoice.articleId
    readerFingerprint = invoice.readerFingerprint
    amountSats = invoice.amountSats
  })

  // Outbound webhook delivery is fire-and-forget — never awaited, never allowed to make
  // this function throw. A slow or unreachable developer endpoint must not delay or fail
  // payment confirmation.
  if (articleId && readerFingerprint !== null && amountSats !== null) {
    enqueueInvoicePaidWebhooks({
      paymentHash,
      articleId,
      readerFingerprint,
      amountSats,
      accessToken: rawJwt,
    })
  }

  // Redis writes happen after transaction commits (per Section 6.3)
  if (rawJwt && tokenHash && articleId) {
    await writeAccessTokenToRedis(rawJwt, tokenHash, articleId)
  }
}

// ─── Get Status ───────────────────────────────────────────────────────────────

export async function getInvoiceStatus(paymentHash: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { paymentHash },
    include: { accessToken: { select: { tokenHash: true } } },
  })

  if (!invoice) return null

  if (invoice.status === 'PAID') {
    let accessToken: string | undefined
    if (invoice.accessToken) {
      const redis = getRedis()
      const stored = await redis.get(`jwt:${invoice.accessToken.tokenHash}`)
      accessToken = stored ?? undefined
    }
    return { status: 'PAID' as const, accessToken }
  }

  // PAID handled above with early return — only terminal/waiting states reach here
  if (invoice.status === 'EXPIRED') return { status: 'EXPIRED' as const }
  if (invoice.status === 'CANCELLED') return { status: 'CANCELLED' as const }
  return { status: 'PENDING' as const }
}

// ─── Expire ───────────────────────────────────────────────────────────────────

export async function expireInvoice(paymentHash: string): Promise<void> {
  // Conditional update: only transitions PENDING → EXPIRED.
  // If invoice was paid between sweep query and this call, updateMany affects 0 rows — no error.
  await prisma.invoice.updateMany({
    where: { paymentHash, status: 'PENDING' },
    data: { status: 'EXPIRED' },
  })
}
