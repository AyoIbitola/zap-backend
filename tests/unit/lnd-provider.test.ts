/**
 * LND webhook signature unit tests (PRD Section 13 — "Webhook signature rejection")
 *
 * These tests cover the verifyWebhookSignature() method in isolation,
 * which is the function the HTTP layer delegates to for 401 decisions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { LNDProvider } from '../../src/lightning/lnd.provider.js'

// LNDProvider reads LND_BASE_URL and LND_MACAROON_HEX in constructor — provide stubs
// so TypeScript doesn't narrow to undefined (runtime: only verifyWebhookSignature is tested)
const originalBaseUrl = process.env.LND_BASE_URL
const originalMacaroon = process.env.LND_MACAROON_HEX

beforeEach(() => {
  process.env.LND_BASE_URL = 'https://stub.lnd.test'
  process.env.LND_MACAROON_HEX = '0102030405'
  delete process.env.LND_WEBHOOK_SECRET
})

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.LND_BASE_URL
  else process.env.LND_BASE_URL = originalBaseUrl
  if (originalMacaroon === undefined) delete process.env.LND_MACAROON_HEX
  else process.env.LND_MACAROON_HEX = originalMacaroon
  delete process.env.LND_WEBHOOK_SECRET
})

function makeProvider() {
  return new LNDProvider()
}

const body = Buffer.from('{"payment_hash":"a1b2c3d4"}')
const secret = 'test-webhook-secret-32-bytes-long!!'

function sign(data: Buffer, key: string) {
  return createHmac('sha256', key).update(data).digest('hex')
}

describe('LNDProvider.verifyWebhookSignature — Option A (no secret)', () => {
  it('returns false when LND_WEBHOOK_SECRET is not set', () => {
    const provider = makeProvider()
    expect(provider.verifyWebhookSignature(body, { 'x-lnd-signature': sign(body, 'any') })).toBe(false)
  })

  it('returns false even with no signature header', () => {
    const provider = makeProvider()
    expect(provider.verifyWebhookSignature(body, {})).toBe(false)
  })
})

describe('LNDProvider.verifyWebhookSignature — Option B (HMAC-SHA256)', () => {
  beforeEach(() => {
    process.env.LND_WEBHOOK_SECRET = secret
  })

  it('returns true for a valid signature', () => {
    const provider = makeProvider()
    const sig = sign(body, secret)
    expect(provider.verifyWebhookSignature(body, { 'x-lnd-signature': sig })).toBe(true)
  })

  it('returns false for an invalid signature', () => {
    const provider = makeProvider()
    expect(provider.verifyWebhookSignature(body, { 'x-lnd-signature': 'deadbeef'.repeat(8) })).toBe(false)
  })

  it('returns false when the signature header is missing', () => {
    const provider = makeProvider()
    expect(provider.verifyWebhookSignature(body, {})).toBe(false)
  })

  it('returns false for a valid signature with a tampered body', () => {
    const provider = makeProvider()
    const sig = sign(body, secret)
    const tampered = Buffer.from('{"payment_hash":"tampered"}')
    expect(provider.verifyWebhookSignature(tampered, { 'x-lnd-signature': sig })).toBe(false)
  })

  it('returns false for a signature generated with the wrong key', () => {
    const provider = makeProvider()
    const sig = sign(body, 'wrong-key')
    expect(provider.verifyWebhookSignature(body, { 'x-lnd-signature': sig })).toBe(false)
  })

  it('returns false for a non-hex signature string', () => {
    const provider = makeProvider()
    expect(provider.verifyWebhookSignature(body, { 'x-lnd-signature': 'not-hex!@#' })).toBe(false)
  })
})
