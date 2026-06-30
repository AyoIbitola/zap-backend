import 'dotenv/config'

console.log('INVOICE_EXPIRY_SECONDS:', JSON.stringify(process.env.INVOICE_EXPIRY_SECONDS))
console.log('LNBITS_BASE_URL:', process.env.LNBITS_BASE_URL)

const expirySecs = parseInt(process.env.INVOICE_EXPIRY_SECONDS ?? '3600', 10)
console.log('expirySecs (parsed):', expirySecs)

const body = JSON.stringify({
  out: false,
  amount: 50,
  memo: 'debug-test',
  expiry: expirySecs,
})
console.log('request body:', body)

const res = await fetch(`${process.env.LNBITS_BASE_URL}/api/v1/payments`, {
  method: 'POST',
  headers: {
    'X-Api-Key': process.env.LNBITS_INVOICE_KEY!,
    'Content-Type': 'application/json',
  },
  body,
})

const data = await res.json() as Record<string, unknown>
console.log('expiry from response:', data['expiry'])
console.log('created_at from response:', data['created_at'])
