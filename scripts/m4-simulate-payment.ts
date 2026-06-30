/**
 * Simulates payment confirmation for M4 acceptance testing.
 * Calls confirmInvoice() directly — same path the worker takes when LNbits reports PAID.
 * Use when the wallet has no balance to actually pay.
 */
import 'dotenv/config'
import { confirmInvoice, getInvoiceStatus } from '../src/services/invoice.service.js'
import { prisma } from '../src/lib/prisma.js'

const PAYMENT_HASH = process.argv[2]
if (!PAYMENT_HASH) {
  console.error('Usage: tsx scripts/m4-simulate-payment.ts <paymentHash>')
  process.exit(1)
}

console.log(`\n=== M4 Acceptance Check — Simulated Payment ===`)
console.log(`paymentHash: ${PAYMENT_HASH}`)

// 1. Verify PENDING before confirm
const before = await getInvoiceStatus(PAYMENT_HASH)
console.log(`\nStatus before confirm: ${before?.status}`)
if (before?.status !== 'PENDING') {
  console.error('Invoice is not PENDING — cannot run test')
  process.exit(1)
}

// 2. Confirm (same path as worker after LNbits reports PAID)
await confirmInvoice(PAYMENT_HASH)

// 3. Check status — must be PAID with accessToken
const after = await getInvoiceStatus(PAYMENT_HASH)
console.log(`Status after confirm:  ${after?.status}`)

if (after?.status !== 'PAID') {
  console.error('FAIL: status is not PAID after confirm')
  process.exit(1)
}

// 4. Decode JWT claims
if (after.accessToken) {
  const parts = after.accessToken.split('.')
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
  console.log(`\naccessToken claims:`)
  console.log(`  articleId:         ${claims.articleId}`)
  console.log(`  readerFingerprint: ${claims.readerFingerprint}`)
  console.log(`  exp:               ${new Date(claims.exp * 1000).toISOString()}`)
} else {
  console.log('accessToken: absent (60s Redis window may have closed)')
}

// 5. Verify exactly 1 AccessToken row in DB
const tokenCount = await prisma.accessToken.count({
  where: { invoice: { paymentHash: PAYMENT_HASH } },
})
console.log(`\nAccessToken rows in DB: ${tokenCount}`)

// 6. Idempotency check — second confirm must not create a second row
await confirmInvoice(PAYMENT_HASH)
const tokenCountAfterSecondConfirm = await prisma.accessToken.count({
  where: { invoice: { paymentHash: PAYMENT_HASH } },
})
console.log(`AccessToken rows after 2nd confirm: ${tokenCountAfterSecondConfirm}`)

// 7. Print results
console.log('\n=== RESULTS ===')
console.log(`status PENDING before confirm:    ${before.status === 'PENDING' ? 'PASS ✓' : 'FAIL ✗'}`)
console.log(`status PAID after confirm:        ${after.status === 'PAID' ? 'PASS ✓' : 'FAIL ✗'}`)
console.log(`accessToken present:              ${after.accessToken ? 'PASS ✓' : 'absent (Redis window) ⚠'}`)
console.log(`exactly 1 AccessToken row:        ${tokenCount === 1 ? 'PASS ✓' : `FAIL ✗ (got ${tokenCount})`}`)
console.log(`idempotent (still 1 after 2x):   ${tokenCountAfterSecondConfirm === 1 ? 'PASS ✓' : `FAIL ✗ (got ${tokenCountAfterSecondConfirm})`}`)

await prisma.$disconnect()
process.exit(tokenCount === 1 && tokenCountAfterSecondConfirm === 1 ? 0 : 1)
