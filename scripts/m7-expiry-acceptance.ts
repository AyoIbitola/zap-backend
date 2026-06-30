/**
 * M7 Acceptance check — Expiry sweep + poller hardening
 *
 * Tests:
 * 1. Sweep catches stale PENDING invoices (expiresAt in past) → EXPIRED, no AccessToken
 * 2. Sweep is idempotent — running twice on the same stale invoice keeps it EXPIRED (count stays 1)
 * 3. Poller discards jobs for already-settled invoices
 * 4. Poller expires an invoice whose expiresAt is in the past (even if LNbits says PENDING)
 * 5. ExpireInvoices cron is registered in BullMQ (upsertJobScheduler)
 */
import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { handleExpireInvoices } from '../src/jobs/handlers/expireInvoices.js'
import { handlePollInvoice } from '../src/jobs/handlers/pollInvoice.js'
import { invoiceSweepQueue } from '../src/jobs/queue.js'
import type { Job } from 'bullmq'

const BASE = 'http://localhost:3001'
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET!

const results: { test: string; pass: boolean }[] = []
function check(test: string, pass: boolean) {
  results.push({ test, pass })
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// ─── Setup: publisher login + published article ───────────────────────────────
const loginRes = await post('/api/auth/login', { email: 'm4test@example.com', password: 'password123' })
const TOKEN = (loginRes.body as { accessToken: string }).accessToken
const authHeader = { Authorization: `Bearer ${TOKEN}` }

const slug = `m7-expiry-test-${Date.now()}`
const artRes = await post('/api/articles', {
  title: 'M7 Expiry Test',
  slug,
  teaserBody: '<p>Teaser</p>',
  fullBody: '<p>Paid content</p>',
  priceSats: 1,
}, authHeader)
const article = artRes.body as { id: string }
await fetch(`${BASE}/api/articles/${article.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ published: true }),
})

// ─── Test 1 + 2: Sweep expires stale invoices, no AccessToken created ─────────
const inv1 = await post('/api/invoices', { articleId: article.id, readerFingerprint: 'm7-fp-sweep' })
const ph1 = (inv1.body as { paymentHash: string }).paymentHash

// Wind back expiresAt to 1 second ago — makes it stale
await prisma.invoice.update({
  where: { paymentHash: ph1 },
  data: { expiresAt: new Date(Date.now() - 1000) },
})

await handleExpireInvoices()

const after1 = await prisma.invoice.findUnique({ where: { paymentHash: ph1 }, select: { status: true } })
check('sweep transitions stale invoice to EXPIRED', after1?.status === 'EXPIRED')

const tokenCount1 = await prisma.accessToken.count({ where: { invoice: { paymentHash: ph1 } } })
check('no AccessToken created for expired invoice', tokenCount1 === 0)

// Run sweep a second time — idempotent (updateMany with WHERE status=PENDING is a no-op)
await handleExpireInvoices()
const after1b = await prisma.invoice.findUnique({ where: { paymentHash: ph1 }, select: { status: true } })
check('sweep is idempotent — second run leaves status EXPIRED', after1b?.status === 'EXPIRED')

// ─── Test 3: Poller discards jobs for already-settled invoices ────────────────
// Re-use ph1 which is already EXPIRED
const fakeJob = { data: { paymentHash: ph1 }, attemptsMade: 0 } as Job<{ paymentHash: string }>
await handlePollInvoice(fakeJob)  // should return early without error

const after3 = await prisma.invoice.findUnique({ where: { paymentHash: ph1 }, select: { status: true } })
check('poller early-exits on already-EXPIRED invoice', after3?.status === 'EXPIRED')

// ─── Test 4: Poller expires invoice whose expiresAt is in the past ────────────
const inv2 = await post('/api/invoices', { articleId: article.id, readerFingerprint: 'm7-fp-poll-expire' })
const ph2 = (inv2.body as { paymentHash: string }).paymentHash

// Wind back expiresAt — poller will detect `new Date() > invoice.expiresAt` even if LNbits says PENDING
await prisma.invoice.update({
  where: { paymentHash: ph2 },
  data: { expiresAt: new Date(Date.now() - 1000) },
})

const fakeJob2 = { data: { paymentHash: ph2 }, attemptsMade: 0 } as Job<{ paymentHash: string }>
await handlePollInvoice(fakeJob2)

const after4 = await prisma.invoice.findUnique({ where: { paymentHash: ph2 }, select: { status: true } })
check('poller expires invoice past its expiresAt', after4?.status === 'EXPIRED')

const tokenCount2 = await prisma.accessToken.count({ where: { invoice: { paymentHash: ph2 } } })
check('no AccessToken created when poller expires invoice', tokenCount2 === 0)

// ─── Test 5: Cron is registered in BullMQ ────────────────────────────────────
const schedulers = await invoiceSweepQueue.getJobSchedulers()
// BullMQ v5 returns { key, name, next, iterationCount, every, ... }
const cron = schedulers.find((s) => s.key === 'expire-invoices-cron')
check('ExpireInvoices cron registered in BullMQ', cron !== undefined)
check('cron interval is 60 seconds', cron?.every === 60000)

// ─── Results ─────────────────────────────────────────────────────────────────
console.log('\n=== M7 ACCEPTANCE RESULTS ===')
for (const { test, pass } of results) {
  console.log(`${pass ? 'PASS ✓' : 'FAIL ✗'}  ${test}`)
}
const allPass = results.every((r) => r.pass)
console.log(`\n${allPass ? 'All checks passed.' : 'Some checks FAILED.'}`)

await invoiceSweepQueue.close()
await prisma.$disconnect()
process.exit(allPass ? 0 : 1)
