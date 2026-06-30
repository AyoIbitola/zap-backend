/**
 * Rate limiting integration tests (PRD Section 13)
 *
 * Covered:
 *   - POST /api/invoices: 5/min per reader fingerprint → 6th returns 429
 *   - 429 response includes Retry-After header
 *   - GET /api/invoices/:hash/status: 30/min per IP → 31st returns 429
 *   - POST /api/auth/login: 10 per 15min per IP → 11th returns 429
 *
 * Each test uses a unique fingerprint / unique IP to avoid cross-test pollution.
 * Redis RL keys are deleted before each test to start from a clean count.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma } from '../../src/lib/prisma.js'
import { getRedis } from '../../src/lib/redis.js'
import app from '../../src/app.js'

const createdPublisherIds: string[] = []
const createdArticleIds: string[] = []

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { articleId: { in: createdArticleIds } } })
  await prisma.article.deleteMany({ where: { id: { in: createdArticleIds } } })
  await prisma.publisher.deleteMany({ where: { id: { in: createdPublisherIds } } })
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createTestPublisher() {
  const pub = await prisma.publisher.create({
    data: {
      email: `rl-test-${Date.now()}-${randomBytes(4).toString('hex')}@zap.invalid`,
      passwordHash: '$2b$12$notusedintests',
      displayName: 'RL Test Publisher',
    },
  })
  createdPublisherIds.push(pub.id)
  return pub
}

async function createTestArticle(publisherId: string) {
  const art = await prisma.article.create({
    data: {
      publisherId,
      title: 'RL Test Article',
      slug: `rl-test-${Date.now()}-${randomBytes(4).toString('hex')}`,
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

function invoiceRequest(articleId: string, fingerprint: string) {
  return app.fetch(
    new Request('http://localhost/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, readerFingerprint: fingerprint }),
    }),
  )
}

function statusRequest(paymentHash: string, ip = '127.0.0.1') {
  return app.fetch(
    new Request(`http://localhost/api/invoices/${paymentHash}/status`, {
      headers: { 'X-Forwarded-For': ip },
    }),
  )
}

function loginRequest(email: string, password: string, ip = '127.0.0.1') {
  return app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email, password }),
    }),
  )
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

const pub = await createTestPublisher()
const article = await createTestArticle(pub.id)
const redis = getRedis()

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/invoices — 5/min per fingerprint', () => {
  it('allows 5 requests then blocks the 6th with 429 and Retry-After', async () => {
    const fp = `rl-fp-${randomBytes(8).toString('hex')}`
    await redis.del(`rl:invoice:fp:${fp}`)

    // Fire all 6 sequentially (concurrent would have race on the counter)
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const res = await invoiceRequest(article.id, fp)
      statuses.push(res.status)
    }

    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true)
    expect(statuses[5]).toBe(429)
  })

  it('429 response includes Retry-After header', async () => {
    const fp = `rl-fp-${randomBytes(8).toString('hex')}`
    await redis.del(`rl:invoice:fp:${fp}`)

    for (let i = 0; i < 5; i++) await invoiceRequest(article.id, fp)
    const res = await invoiceRequest(article.id, fp)

    expect(res.status).toBe(429)
    const retryAfter = res.headers.get('Retry-After')
    expect(retryAfter).not.toBeNull()
    expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0)
  })
})

describe('GET /api/invoices/:hash/status — 30/min per IP', () => {
  it('allows 30 requests then blocks the 31st with 429', async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 254) + 1}`  // unique test IP (RFC 5737)
    const fakeHash = 'a'.repeat(64)

    // Clear the RL key for this IP
    await redis.del(`rl:${ip}`)

    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const res = await statusRequest(fakeHash, ip)
      statuses.push(res.status)
    }

    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe('POST /api/auth/login — 10 per 15min per IP', () => {
  it('allows 10 attempts then blocks the 11th with 429', async () => {
    // Use a unique IP so we don't interfere with other tests
    const ip = `198.51.100.${Math.floor(Math.random() * 254) + 1}`  // RFC 5737 test range
    await redis.del(`rl:${ip}`)

    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      // All will fail with 401 (wrong credentials) but that's fine — we test the RL layer
      const res = await loginRequest(`rl-test-${i}@zap.invalid`, 'wrongpassword', ip)
      statuses.push(res.status)
    }

    // First 10 pass the rate limiter (respond 401 — wrong creds)
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
    // 11th is blocked before even reaching auth logic
    expect(statuses[10]).toBe(429)
  })
})
