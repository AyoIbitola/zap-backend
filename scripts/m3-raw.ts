import 'dotenv/config'
import { LNbitsProvider } from '../src/lightning/lnbits.provider.js'

// Monkey-patch fetch to log raw response
const origFetch = globalThis.fetch
globalThis.fetch = async (...args) => {
  const res = await origFetch(...args)
  const clone = res.clone()
  const body = await clone.json()
  console.log('RAW LNbits response:', JSON.stringify({ expiry: body.expiry, created_at: body.created_at, payment_hash: body.payment_hash }, null, 2))
  return res
}

const provider = new LNbitsProvider()
const before = new Date()
const result = await provider.createInvoice(50, 'milestone-3-raw-test')
const after = new Date()

console.log('\nnow (before):', before.toISOString())
console.log('now (after): ', after.toISOString())
console.log('expiresAt:   ', result.expiresAt.toISOString())
console.log('TTL seconds: ', Math.round((result.expiresAt.getTime() - before.getTime()) / 1000))
