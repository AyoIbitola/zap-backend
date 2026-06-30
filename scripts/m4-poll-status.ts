import 'dotenv/config'

const PAYMENT_HASH = process.argv[2]
if (!PAYMENT_HASH) {
  console.error('Usage: tsx scripts/m4-poll-status.ts <paymentHash>')
  process.exit(1)
}

console.log(`\nPolling status for: ${PAYMENT_HASH}`)
console.log('Waiting up to 90 seconds for PAID...\n')

const start = Date.now()
let attempts = 0

while (Date.now() - start < 90_000) {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  const res = await fetch(`http://localhost:3001/api/invoices/${PAYMENT_HASH}/status`)
  const body = (await res.json()) as { status: string; accessToken?: string }

  attempts++
  console.log(`[${elapsed}s / attempt ${attempts}] status: ${body.status}`)

  if (body.status === 'PAID') {
    console.log('\n=== ACCEPTANCE CHECK RESULTS ===')
    console.log(`status === 'PAID': PASS ✓`)
    console.log(`elapsed: ${elapsed}s (must be ≤ 10s after payment)`)

    if (body.accessToken) {
      const parts = body.accessToken.split('.')
      const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
      console.log(`accessToken present: PASS ✓`)
      console.log(`accessToken.articleId: ${claims.articleId}`)
      console.log(`accessToken.readerFingerprint: ${claims.readerFingerprint}`)
    } else {
      console.log('accessToken: absent (JWT 60s window may have closed)')
    }
    process.exit(0)
  }

  if (body.status === 'EXPIRED') {
    console.log('\nInvoice expired before payment. Test failed.')
    process.exit(1)
  }

  await new Promise((r) => setTimeout(r, 2000))
}

console.log('\nTimeout: invoice not paid within 90 seconds.')
process.exit(1)
