/**
 * Webhook integration tests (PRD Section 13)
 *
 * Covered:
 *   - Deduplication: same paymentHash delivered twice → one WebhookEvent, one AccessToken
 *   - Uses app.fetch() to exercise the full HTTP pipeline (signature check, dedup, confirmInvoice)
 *
 * Note: Signature rejection is covered at the unit level in tests/unit/lnd-provider.test.ts.
 * The live endpoint uses LNbitsProvider whose verifyWebhookSignature always returns true,
 * so we can send raw JSON without a signature header here.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma } from '../../src/lib/prisma.js'
import app from '../../src/app.js'

// ─── Test data tracking ───────────────────────────────────────────────────────
const createdPublisherIds: string[] = []
const createdArticleIds: string[] = []

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({
    where: { dedupKey: { startsWith: 'webhook-test-' } },
  })
  await prisma.accessToken.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.invoice.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.article.deleteMany({ where: { id: { in: createdArticleIds } } })
  await prisma.publisher.deleteMany({ where: { id: { in: createdPublisherIds } } })
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTestPublisher() {
  const pub = await prisma.publisher.create({
    data: {
      email: `wh-test-${Date.now()}-${randomBytes(4).toString('hex')}@zap.invalid`,
      passwordHash: '$2b$12$notusedintests',
      displayName: 'WH Test Publisher',
    },
  })
  createdPublisherIds.push(pub.id)
  return pub
}

async function createTestArticle(publisherId: string) {
  const art = await prisma.article.create({
    data: {
      publisherId,
      title: 'WH Test Article',
      slug: `wh-test-${Date.now()}-${randomBytes(4).toString('hex')}`,
      teaserBody: '<p>T</p>',
      fullBody: '<p>F</p>',
      priceSats: 10,
      published: true,
      publishedAt: new Date(),
    },
  })
  createdArticleIds.push(art.id)
  return art
}

async function createPendingInvoice(articleId: string, paymentHash: string) {
  return prisma.invoice.create({
    data: {
      paymentHash,
      invoiceString: `lnbc10n1test${randomBytes(4).toString('hex')}`,
      amountSats: 10,
      readerFingerprint: `fp-${randomBytes(4).toString('hex')}`,
      status: 'PENDING',
      nodeProvider: 'LNBITS',
      articleId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
}

function postWebhook(paymentHash: string) {
  return app.fetch(
    new Request('http://localhost/webhooks/lightning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_hash: paymentHash }),
    }),
  )
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

const pub = await createTestPublisher()
const article = await createTestArticle(pub.id)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Webhook deduplication (PRD Section 13)', () => {
  it('delivering the same payment_hash twice creates exactly one WebhookEvent and one AccessToken', async () => {
    const paymentHash = randomBytes(32).toString('hex')
    await createPendingInvoice(article.id, paymentHash)

    const [res1, res2] = await Promise.all([postWebhook(paymentHash), postWebhook(paymentHash)])

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    const dedupKey = `${paymentHash}:payment_received`
    const eventCount = await prisma.webhookEvent.count({ where: { dedupKey } })
    expect(eventCount).toBe(1)

    const tokenCount = await prisma.accessToken.count({
      where: { invoice: { paymentHash } },
    })
    expect(tokenCount).toBe(1)
  })

  it('missing payment_hash field returns 200 without creating any event', async () => {
    const body = JSON.stringify({ some_other_field: 'value' })
    const res = await app.fetch(
      new Request('http://localhost/webhooks/lightning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    )
    expect(res.status).toBe(200)
  })

  it('stale paymentHash (no matching invoice) returns 200 without creating AccessToken', async () => {
    const ghostHash = randomBytes(32).toString('hex')
    const res = await postWebhook(ghostHash)
    expect(res.status).toBe(200)

    const tokenCount = await prisma.accessToken.count({
      where: { invoice: { paymentHash: ghostHash } },
    })
    expect(tokenCount).toBe(0)
  })
})
