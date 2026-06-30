/**
 * Content gating integration tests (PRD Section 13)
 *
 * Non-negotiable rule: "Never send fullBody to an unauthenticated request."
 *
 * Covered:
 *   - GET /api/articles never returns fullBody
 *   - GET /api/articles/:slug never returns fullBody
 *   - POST /api/articles/:slug/unlock without X-Internal-Secret → 401
 *   - POST /api/articles/:slug/unlock with invalid access token → 401
 *   - POST /api/articles/:slug/unlock with valid token → 200 with fullBody
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma } from '../../src/lib/prisma.js'
import { confirmInvoice } from '../../src/services/invoice.service.js'
import { getRedis } from '../../src/lib/redis.js'
import app from '../../src/app.js'

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET!

// ─── Test data tracking ───────────────────────────────────────────────────────
const createdPublisherIds: string[] = []
const createdArticleIds: string[] = []

afterAll(async () => {
  await prisma.accessToken.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.invoice.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.article.deleteMany({ where: { id: { in: createdArticleIds } } })
  await prisma.publisher.deleteMany({ where: { id: { in: createdPublisherIds } } })
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTestPublisher() {
  const pub = await prisma.publisher.create({
    data: {
      email: `cg-test-${Date.now()}-${randomBytes(4).toString('hex')}@zap.invalid`,
      passwordHash: '$2b$12$notusedintests',
      displayName: 'CG Test Publisher',
    },
  })
  createdPublisherIds.push(pub.id)
  return pub
}

async function createTestArticle(publisherId: string, slug?: string) {
  const art = await prisma.article.create({
    data: {
      publisherId,
      title: 'CG Test Article',
      slug: slug ?? `cg-test-${Date.now()}-${randomBytes(4).toString('hex')}`,
      teaserBody: '<p>Teaser only</p>',
      fullBody: '<p>SECRET FULL CONTENT</p>',
      priceSats: 10,
      published: true,
      publishedAt: new Date(),
    },
  })
  createdArticleIds.push(art.id)
  return art
}

async function createPaidInvoice(articleId: string): Promise<{ paymentHash: string }> {
  const paymentHash = randomBytes(32).toString('hex')
  await prisma.invoice.create({
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
  await confirmInvoice(paymentHash)
  return { paymentHash }
}

async function getAccessTokenJwt(paymentHash: string): Promise<string> {
  // After confirmInvoice, the JWT is stored in Redis for 60s
  const invoice = await prisma.invoice.findUnique({
    where: { paymentHash },
    include: { accessToken: true },
  })
  const tokenHash = invoice?.accessToken?.tokenHash
  if (!tokenHash) throw new Error('AccessToken not found after confirm')
  const redis = getRedis()
  const jwt = await redis.get(`jwt:${tokenHash}`)
  if (!jwt) throw new Error('JWT not in Redis after confirm')
  return jwt
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

const pub = await createTestPublisher()
const article = await createTestArticle(pub.id)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('fullBody never leaks via public GET endpoints', () => {
  it('GET /api/articles does not include fullBody in any article', async () => {
    const res = await app.fetch(new Request('http://localhost/api/articles'))
    expect(res.status).toBe(200)
    const list = (await res.json()) as Array<Record<string, unknown>>
    for (const a of list) {
      expect(Object.keys(a)).not.toContain('fullBody')
    }
  })

  it('GET /api/articles/:slug does not include fullBody', async () => {
    const res = await app.fetch(new Request(`http://localhost/api/articles/${article.slug}`))
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>
    expect(Object.keys(data)).not.toContain('fullBody')
    expect(data.teaserBody).toBeDefined()
  })
})

describe('POST /api/articles/:slug/unlock — access control', () => {
  it('returns 403 when X-Internal-Secret header is missing', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/articles/${article.slug}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: 'any-token' }),
      }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 when X-Internal-Secret is wrong', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/articles/${article.slug}/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': 'wrong-secret',
        },
        body: JSON.stringify({ accessToken: 'any-token' }),
      }),
    )
    expect(res.status).toBe(403)
  })

  it('returns 401 for an invalid access token with correct secret', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/articles/${article.slug}/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({ accessToken: 'not.a.valid.jwt' }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 200 with fullBody for a valid paid access token', async () => {
    const { paymentHash } = await createPaidInvoice(article.id)
    const jwt = await getAccessTokenJwt(paymentHash)

    const res = await app.fetch(
      new Request(`http://localhost/api/articles/${article.slug}/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({ accessToken: jwt }),
      }),
    )

    expect(res.status).toBe(200)
    const data = (await res.json()) as { fullBody: string; articleId: string }
    expect(data.fullBody).toBe('<p>SECRET FULL CONTENT</p>')
    expect(data.articleId).toBe(article.id)
  })

  it('returns 401 for a token issued for a different article', async () => {
    const otherArticle = await createTestArticle(pub.id)
    const { paymentHash } = await createPaidInvoice(otherArticle.id)
    const jwt = await getAccessTokenJwt(paymentHash)

    const res = await app.fetch(
      new Request(`http://localhost/api/articles/${article.slug}/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({ accessToken: jwt }),
      }),
    )

    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('unauthorized')
  })
})
