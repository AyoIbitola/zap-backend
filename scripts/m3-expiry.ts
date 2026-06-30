import 'dotenv/config'
import { LNbitsProvider } from '../src/lightning/lnbits.provider.js'

const provider = new LNbitsProvider()
const before = new Date()
const result = await provider.createInvoice(50, 'milestone-3-expiry-check')

const ttlSeconds = (result.expiresAt.getTime() - before.getTime()) / 1000
console.log('created at (before):', before.toISOString())
console.log('expiresAt:          ', result.expiresAt.toISOString())
console.log('TTL seconds:        ', Math.round(ttlSeconds))
console.log('paymentHash:', result.paymentHash)
console.log('')
console.log('expiresAt is valid Date:', !isNaN(result.expiresAt.getTime()) ? 'PASS ✓' : 'FAIL ✗')
console.log('TTL is positive:        ', ttlSeconds > 0 ? 'PASS ✓' : 'FAIL ✗')
