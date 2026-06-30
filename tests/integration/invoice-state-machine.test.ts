/**
 * Invoice state machine integration tests (PRD Section 13)
 *
 * Tests run against the real Postgres + Redis. Each test creates isolated
 * data with unique slugs/hashes and cleans up via afterAll.
 *
 * Covered:
 *   - PENDING → PAID (via confirmInvoice)
 *   - PAID → PAID (sequential idempotency — second call is a no-op)
 *   - PENDING → EXPIRED (via expireInvoice)
 *   - Already-PAID invoice → expireInvoice is a no-op (updateMany WHERE PENDING = 0 rows)
 *   - EXPIRED → PAID throws InvalidInvoiceTransitionError
 *   - CANCELLED → PAID throws InvalidInvoiceTransitionError
 *   - Concurrent confirmInvoice calls → exactly one AccessToken
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma } from '../../src/lib/prisma.js'
import { confirmInvoice, expireInvoice } from '../../src/services/invoice.service.js'
import { InvalidInvoiceTransitionError, InvoiceNotFoundError } from '../../src/types/errors.js'

// ─── Test data created during this suite ─────────────────────────────────────
const createdPublisherIds: string[] = []
const createdArticleIds: string[] = []

afterAll(async () => {
  // Delete in reverse dependency order
  await prisma.accessToken.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.invoice.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.article.deleteMany({ where: { id: { in: createdArticleIds } } })
  await prisma.publisher.deleteMany({ where: { id: { in: createdPublisherIds } } })
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTestPublisher() {
  const pub = await prisma.publisher.create({
    data: {
      email: `sm-test-${Date.now()}-${randomBytes(4).toString('hex')}@zap.invalid`,
      passwordHash: '$2b$12$notusedintests',
      displayName: 'SM Test Publisher',
    },
  })
  createdPublisherIds.push(pub.id)
  return pub
}

async function createTestArticle(publisherId: string) {
  const art = await prisma.article.create({
    data: {
      publisherId,
      title: 'SM Test Article',
      slug: `sm-test-${Date.now()}-${randomBytes(4).toString('hex')}`,
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

async function createPendingInvoice(articleId: string, paymentHash?: string) {
  return prisma.invoice.create({
    data: {
      paymentHash: paymentHash ?? randomBytes(32).toString('hex'),
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

// ─── Suite setup ─────────────────────────────────────────────────────────────

const pub = await createTestPublisher()
const article = await createTestArticle(pub.id)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Invoice state machine — transitions', () => {
  it('PENDING → PAID via confirmInvoice', async () => {
    const inv = await createPendingInvoice(article.id)
    await confirmInvoice(inv.paymentHash)

    const updated = await prisma.invoice.findUnique({ where: { id: inv.id } })
    expect(updated!.status).toBe('PAID')
    expect(updated!.confirmedAt).not.toBeNull()

    const token = await prisma.accessToken.findFirst({ where: { invoiceId: inv.id } })
    expect(token).not.toBeNull()
  })

  it('PAID → PAID (sequential) — confirmInvoice is a no-op, no second AccessToken created', async () => {
    const inv = await createPendingInvoice(article.id)
    await confirmInvoice(inv.paymentHash)
    await confirmInvoice(inv.paymentHash)  // Second call — must not throw

    const count = await prisma.accessToken.count({ where: { invoiceId: inv.id } })
    expect(count).toBe(1)
  })

  it('PENDING → EXPIRED via expireInvoice', async () => {
    const inv = await createPendingInvoice(article.id)
    await expireInvoice(inv.paymentHash)

    const updated = await prisma.invoice.findUnique({ where: { id: inv.id } })
    expect(updated!.status).toBe('EXPIRED')
  })

  it('expireInvoice on a PAID invoice is a no-op (conditional updateMany)', async () => {
    const inv = await createPendingInvoice(article.id)
    await confirmInvoice(inv.paymentHash)
    await expireInvoice(inv.paymentHash)  // Must not change status

    const updated = await prisma.invoice.findUnique({ where: { id: inv.id } })
    expect(updated!.status).toBe('PAID')
  })

  it('EXPIRED → PAID throws InvalidInvoiceTransitionError', async () => {
    const inv = await prisma.invoice.create({
      data: {
        paymentHash: randomBytes(32).toString('hex'),
        invoiceString: `lnbc10n1test${randomBytes(4).toString('hex')}`,
        amountSats: 10,
        readerFingerprint: 'fp-expired',
        status: 'EXPIRED',
        nodeProvider: 'LNBITS',
        articleId: article.id,
        expiresAt: new Date(Date.now() - 1_000),
      },
    })

    await expect(confirmInvoice(inv.paymentHash)).rejects.toThrow(InvalidInvoiceTransitionError)
  })

  it('CANCELLED → PAID throws InvalidInvoiceTransitionError', async () => {
    const inv = await prisma.invoice.create({
      data: {
        paymentHash: randomBytes(32).toString('hex'),
        invoiceString: `lnbc10n1test${randomBytes(4).toString('hex')}`,
        amountSats: 10,
        readerFingerprint: 'fp-cancelled',
        status: 'CANCELLED',
        nodeProvider: 'LNBITS',
        articleId: article.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })

    await expect(confirmInvoice(inv.paymentHash)).rejects.toThrow(InvalidInvoiceTransitionError)
  })

  it('unknown paymentHash throws InvoiceNotFoundError', async () => {
    await expect(confirmInvoice(randomBytes(32).toString('hex'))).rejects.toThrow(InvoiceNotFoundError)
  })
})

describe('Invoice state machine — concurrency (PRD Section 13)', () => {
  it('two concurrent confirmInvoice calls produce exactly one AccessToken', async () => {
    const inv = await createPendingInvoice(article.id)

    // Fire both confirms simultaneously — the loser sees 0 rows from updateMany and returns silently
    const [r1, r2] = await Promise.allSettled([
      confirmInvoice(inv.paymentHash),
      confirmInvoice(inv.paymentHash),
    ])

    expect(r1.status).toBe('fulfilled')
    expect(r2.status).toBe('fulfilled')

    const count = await prisma.accessToken.count({ where: { invoiceId: inv.id } })
    expect(count).toBe(1)

    const updated = await prisma.invoice.findUnique({ where: { id: inv.id } })
    expect(updated!.status).toBe('PAID')
  })
})
