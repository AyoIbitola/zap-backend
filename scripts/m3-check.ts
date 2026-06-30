import 'dotenv/config'
import { LNbitsProvider } from '../src/lightning/lnbits.provider.js'

const provider = new LNbitsProvider()
const result = await provider.createInvoice(50, 'milestone-3-test')

console.log('paymentHash:', result.paymentHash)
console.log('paymentHash length:', result.paymentHash.length)
console.log('invoiceString starts with:', result.invoiceString.slice(0, 6))
console.log('amountSats:', result.amountSats)
console.log('expiresAt:', result.expiresAt.toISOString())

const validHash = /^[0-9a-f]{64}$/.test(result.paymentHash)
const validBolt11 =
  result.invoiceString.startsWith('lnbc') || result.invoiceString.startsWith('lntb')

console.log('\n--- ACCEPTANCE CHECK ---')
console.log('64-char hex paymentHash:', validHash ? 'PASS ✓' : 'FAIL ✗')
console.log('BOLT11 starts lnbc/lntb:', validBolt11 ? 'PASS ✓' : 'FAIL ✗')
console.log('amountSats === 50:', result.amountSats === 50 ? 'PASS ✓' : 'FAIL ✗')
console.log('expiresAt is in future:', result.expiresAt > new Date() ? 'PASS ✓' : 'FAIL ✗')
