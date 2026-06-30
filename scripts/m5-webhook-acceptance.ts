/**
 * M5 Acceptance check — Webhook receiver
 *
 * Tests (without a real payment):
 * 1. POST /webhooks/lightning with a real payment_hash → invoice is confirmed
 * 2. Deduplication: same webhook delivered twice → exactly one WebhookEvent row, one AccessToken
 * 3. Unknown payment_hash → returns 200 silently (no error, no infinite retry)
 * 4. Already-paid invoice → returns 200 (idempotent)
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { confirmInvoice } from '../src/services/invoice.service.js'

const BASE = 'http://localhost:3001'

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// ─── Setup: create a fresh invoice for testing ────────────────────────────────
const TOKEN = process.argv[2]
if (!TOKEN) {
  console.error('Usage: tsx scripts/m5-webhook-acceptance.ts <publisher_jwt>')
  process.exit(1)
}

// Create article
const artRes = await fetch(`${BASE}/api/articles`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    title: 'M5 Webhook Test Article',
    slug: `m5-webhook-test-${Date.now()}`,
    teaserBody: '<p>Teaser</p>',
    fullBody: '<p>Paid content</p>',
    priceSats: 1,
  }),
})
const article = (await artRes.json()) as { id: string }
await fetch(`${BASE}/api/articles/${article.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ published: true }),
})

// Create invoice
const invRes = await post('/api/invoices', {
  articleId: article.id,
  readerFingerprint: 'm5-test-fingerprint',
})
const invoice = invRes.body as { paymentHash: string }
console.log(`\nTest invoice: ${invoice.paymentHash.slice(0, 12)}…`)

const results: { test: string; pass: boolean }[] = []

// ─── Test 1: webhook fires → invoice confirmed ─────────────────────────────────
const wh1 = await post('/webhooks/lightning', { payment_hash: invoice.paymentHash })
results.push({ test: 'webhook returns 200', pass: wh1.status === 200 })

const statusRes = await fetch(`${BASE}/api/invoices/${invoice.paymentHash}/status`)
const statusBody = (await statusRes.json()) as { status: string }
results.push({ test: "status is PAID after webhook", pass: statusBody.status === 'PAID' })

// ─── Test 2: dedup — deliver same webhook twice ────────────────────────────────
const wh2 = await post('/webhooks/lightning', { payment_hash: invoice.paymentHash })
results.push({ test: 'duplicate webhook returns 200', pass: wh2.status === 200 })

const eventCount = await prisma.webhookEvent.count({
  where: { dedupKey: `${invoice.paymentHash}:payment_received` },
})
results.push({ test: 'exactly 1 WebhookEvent row after 2 deliveries', pass: eventCount === 1 })

const tokenCount = await prisma.accessToken.count({
  where: { invoice: { paymentHash: invoice.paymentHash } },
})
results.push({ test: 'exactly 1 AccessToken row after 2 deliveries', pass: tokenCount === 1 })

// ─── Test 3: unknown payment_hash → 200 (no retry loop) ──────────────────────
const unknownHash = 'a'.repeat(64)
const wh3 = await post('/webhooks/lightning', { payment_hash: unknownHash })
// webhook creates a WebhookEvent row first, then confirmInvoice throws InvoiceNotFoundError
results.push({ test: 'unknown payment_hash returns 200', pass: wh3.status === 200 })

// ─── Test 4: missing payment_hash → 200 ───────────────────────────────────────
const wh4 = await post('/webhooks/lightning', { bad_field: 'nope' })
results.push({ test: 'missing payment_hash returns 200', pass: wh4.status === 200 })

// ─── Print results ─────────────────────────────────────────────────────────────
console.log('\n=== M5 ACCEPTANCE RESULTS ===')
for (const { test, pass } of results) {
  console.log(`${pass ? 'PASS ✓' : 'FAIL ✗'}  ${test}`)
}

const allPass = results.every((r) => r.pass)
await prisma.$disconnect()
process.exit(allPass ? 0 : 1)
