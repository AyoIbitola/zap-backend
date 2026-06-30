import { describe, it, expect } from 'vitest'
import { LNbitsProvider } from '../../src/lightning/lnbits.provider.js'

const provider = new LNbitsProvider()
const body = Buffer.from('{"payment_hash":"abc"}')

describe('LNbitsProvider.verifyWebhookSignature', () => {
  it('returns true regardless of headers — LNbits sends no signature', () => {
    expect(provider.verifyWebhookSignature(body, {})).toBe(true)
  })

  it('returns true even with arbitrary headers', () => {
    expect(provider.verifyWebhookSignature(body, { 'x-lnd-signature': 'junk' })).toBe(true)
  })

  it('returns true for empty body', () => {
    expect(provider.verifyWebhookSignature(Buffer.from(''), {})).toBe(true)
  })
})

describe('LNbitsProvider.getInvoiceStatus response parsing', () => {
  it('maps paid:true to PAID', async () => {
    const originalFetch = global.fetch
    global.fetch = async () =>
      new Response(JSON.stringify({ paid: true, details: { payment_hash: 'abc', updated_at: new Date().toISOString() } }), {
        status: 200,
      })

    const result = await provider.getInvoiceStatus('a'.repeat(64))
    expect(result.status).toBe('PAID')
    global.fetch = originalFetch
  })

  it('maps paid:false + status:pending to PENDING', async () => {
    const originalFetch = global.fetch
    global.fetch = async () =>
      new Response(JSON.stringify({ paid: false, status: 'pending', preimage: null }), { status: 200 })

    const result = await provider.getInvoiceStatus('a'.repeat(64))
    expect(result.status).toBe('PENDING')
    global.fetch = originalFetch
  })

  it('maps paid:false + status:failed to EXPIRED', async () => {
    const originalFetch = global.fetch
    global.fetch = async () =>
      new Response(JSON.stringify({ paid: false, status: 'failed', preimage: null }), { status: 200 })

    const result = await provider.getInvoiceStatus('a'.repeat(64))
    expect(result.status).toBe('EXPIRED')
    global.fetch = originalFetch
  })
})
