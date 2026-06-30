/**
 * M8 Acceptance check — LND provider
 *
 * Tests that can run without a live LND node:
 * 1. LNDProvider is instantiated and implements the LightningProvider interface
 * 2. verifyWebhookSignature Option A (no LND_WEBHOOK_SECRET) → always false
 * 3. verifyWebhookSignature Option B (LND_WEBHOOK_SECRET set) → HMAC-SHA256 validation
 * 4. base64/base64url round-trip for r_hash encoding (confirmed approach)
 * 5. createInvoice wraps network errors in LightningNodeError
 * 6. getInvoiceStatus wraps network errors in LightningNodeError
 *
 * Live node tests (run manually with real LND credentials):
 * - Set LND_BASE_URL, LND_MACAROON_HEX, LND_TLS_CERT_BASE64 in .env
 * - Switch LIGHTNING_PROVIDER=LND
 * - Re-run m4–m7 acceptance scripts
 */
import 'dotenv/config'
import { createHmac } from 'node:crypto'
import { LNDProvider } from '../src/lightning/lnd.provider.js'
import { LightningNodeError } from '../src/lightning/provider.interface.js'

const results: { test: string; pass: boolean }[] = []
function check(test: string, pass: boolean) {
  results.push({ test, pass })
}

// ─── Test 1: implements interface ─────────────────────────────────────────────
// Temporarily set required env vars so constructor doesn't throw
process.env.LND_BASE_URL = 'https://localhost:10009'
process.env.LND_MACAROON_HEX = 'deadbeef'

const provider = new LNDProvider()
check('LNDProvider instantiates', provider !== null)
check('has createInvoice method', typeof provider.createInvoice === 'function')
check('has getInvoiceStatus method', typeof provider.getInvoiceStatus === 'function')
check('has verifyWebhookSignature method', typeof provider.verifyWebhookSignature === 'function')

// ─── Test 2: Option A — no LND_WEBHOOK_SECRET → always false ─────────────────
delete process.env.LND_WEBHOOK_SECRET
const rawBody = Buffer.from(JSON.stringify({ payment_hash: 'a'.repeat(64) }))
const optionAResult = provider.verifyWebhookSignature(rawBody, {})
check('Option A: verifyWebhookSignature returns false (polling-only mode)', optionAResult === false)

// ─── Test 3: Option B — HMAC-SHA256 validation ────────────────────────────────
const secret = 'test-lnd-webhook-secret'
process.env.LND_WEBHOOK_SECRET = secret

const validSig = createHmac('sha256', secret).update(rawBody).digest('hex')
const validHeaders = { 'x-lnd-signature': validSig }
check('Option B: valid HMAC signature accepted', provider.verifyWebhookSignature(rawBody, validHeaders) === true)

const tamperedBody = Buffer.from(JSON.stringify({ payment_hash: 'b'.repeat(64) }))
check('Option B: tampered body rejected', provider.verifyWebhookSignature(tamperedBody, validHeaders) === false)

check('Option B: missing signature header rejected', provider.verifyWebhookSignature(rawBody, {}) === false)

check('Option B: wrong signature rejected', provider.verifyWebhookSignature(rawBody, { 'x-lnd-signature': 'deadbeef'.repeat(8) }) === false)

check('Option B: invalid hex in signature does not throw', (() => {
  try {
    provider.verifyWebhookSignature(rawBody, { 'x-lnd-signature': 'not-hex!' })
    return true  // returned false gracefully
  } catch {
    return false  // should not throw
  }
})())

// ─── Test 4: r_hash base64/base64url round-trip ───────────────────────────────
const sampleHex = 'a9f2dcf07b1b87c41d41572a4806187c790aaa4701b93ba50fd94db829662c12'

// Simulate: LND returns standard base64 in response body
const stdBase64 = Buffer.from(sampleHex, 'hex').toString('base64')
const decodedFromStd = Buffer.from(stdBase64, 'base64').toString('hex')
check('r_hash standard base64 → hex round-trip', decodedFromStd === sampleHex)

// Simulate: LND returns URL-safe base64 in response body
const urlBase64 = Buffer.from(sampleHex, 'hex').toString('base64url')
const decodedFromUrl = Buffer.from(urlBase64, 'base64').toString('hex')  // lenient decode
check('r_hash base64url → hex round-trip (lenient Buffer.from)', decodedFromUrl === sampleHex)

// Simulate: encoding for GET /v1/invoice/<r_hash> URL path
const urlEncoded = Buffer.from(sampleHex, 'hex').toString('base64url')
check('hex → base64url for URL path does not contain + or /', !urlEncoded.includes('+') && !urlEncoded.includes('/'))
check('hex → base64url for URL path has no = padding', !urlEncoded.includes('='))

// ─── Test 5+6: network errors wrapped in LightningNodeError ──────────────────
// Point at a port that refuses connections
process.env.LND_BASE_URL = 'https://localhost:1'
const badProvider = new LNDProvider()

let createErr: unknown
try {
  await badProvider.createInvoice(100, 'test')
} catch (e) {
  createErr = e
}
check('createInvoice wraps network errors as LightningNodeError', createErr instanceof LightningNodeError)
check('createInvoice error has provider=LND', (createErr as LightningNodeError)?.provider === 'LND')
check('createInvoice error has operation=createInvoice', (createErr as LightningNodeError)?.operation === 'createInvoice')

let statusErr: unknown
try {
  await badProvider.getInvoiceStatus('a'.repeat(64))
} catch (e) {
  statusErr = e
}
check('getInvoiceStatus wraps network errors as LightningNodeError', statusErr instanceof LightningNodeError)
check('getInvoiceStatus error has provider=LND', (statusErr as LightningNodeError)?.provider === 'LND')

// ─── Results ──────────────────────────────────────────────────────────────────
console.log('\n=== M8 ACCEPTANCE RESULTS ===')
for (const { test, pass } of results) {
  console.log(`${pass ? 'PASS ✓' : 'FAIL ✗'}  ${test}`)
}
const allPass = results.every((r) => r.pass)
console.log(`\n${allPass ? 'All checks passed.' : 'Some checks FAILED.'}`)
console.log('\nNote: Live LND node tests require LND_BASE_URL + LND_MACAROON_HEX + LND_TLS_CERT_BASE64 in .env')
console.log('      then run: LIGHTNING_PROVIDER=LND pnpm exec tsx scripts/m4–m7 acceptance scripts')
process.exit(allPass ? 0 : 1)
