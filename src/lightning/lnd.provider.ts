// LND provider — targets LND REST API (grpc-gateway)
//
// [CONFIRM 4 — resolved] r_hash encoding:
//   LND REST (grpc-gateway) returns r_hash as standard base64 with = padding.
//   Node.js Buffer.from(str, 'base64') is lenient and accepts both standard and URL-safe,
//   so decoding is safe regardless of which variant the node returns.
//   URL path for GET /v1/invoice/<r_hash> requires URL-safe base64 (base64url, no padding).
//
// [CONFIRM 5 — resolved] Webhook strategy:
//   Option A (polling only) is the default — LND has no native webhook push.
//   Option B (HMAC bridge) activates when LND_WEBHOOK_SECRET is set.
//   Option A: verifyWebhookSignature returns false → POST /webhooks/lightning returns 401.
//     This is correct: we never register a webhook URL with LND, so no legitimate caller exists.
//   Option B: X-LND-Signature = hex(HMAC-SHA256(rawBody, LND_WEBHOOK_SECRET))
//
// TLS: LND uses a self-signed cert. LND_TLS_CERT_BASE64 = base64(PEM cert).
//   native fetch() does not support custom CA certs — we use node:https directly.

import https from 'node:https'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  LightningProvider,
  CreateInvoiceResult,
  InvoiceStatusResult,
  BalanceResult,
  PayoutResult,
} from './provider.interface.js'
import { LightningNodeError } from './provider.interface.js'

// ─── TLS-aware fetch helper ───────────────────────────────────────────────────

function buildAgent(): https.Agent {
  const certB64 = process.env.LND_TLS_CERT_BASE64
  if (!certB64) return new https.Agent()
  const ca = Buffer.from(certB64, 'base64').toString('utf-8')
  return new https.Agent({ ca })
}

interface SimpleResponse {
  status: number
  ok: boolean
  json(): Promise<unknown>
  text(): Promise<string>
}

async function lndFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<SimpleResponse> {
  const agent = buildAgent()
  const parsed = new URL(url)

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({
            status,
            ok: status >= 200 && status < 300,
            json: async () => JSON.parse(data) as unknown,
            text: async () => data,
          })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

// ─── Response shapes ──────────────────────────────────────────────────────────

interface LNDCreateResponse {
  r_hash: string          // standard base64-encoded payment hash bytes
  payment_request: string // BOLT11 string
  add_index: string
}

interface LNDInvoiceResponse {
  state: 'SETTLED' | 'OPEN' | 'CANCELED' | 'ACCEPTED'
  settled: boolean
  settle_date: string   // unix timestamp as string (seconds)
  creation_date: string // unix timestamp as string
  expiry: string        // TTL in seconds as string
  payment_request: string
}

// ─── LNDProvider ──────────────────────────────────────────────────────────────

export class LNDProvider implements LightningProvider {
  private readonly baseUrl: string
  private readonly macaroonHex: string

  constructor() {
    this.baseUrl = process.env.LND_BASE_URL!
    this.macaroonHex = process.env.LND_MACAROON_HEX!
  }

  private get authHeaders(): Record<string, string> {
    return {
      'Grpc-Metadata-Macaroon': this.macaroonHex,
      'Content-Type': 'application/json',
    }
  }

  async createInvoice(amountSats: number, memo: string): Promise<CreateInvoiceResult> {
    const expirySecs = parseInt(process.env.INVOICE_EXPIRY_SECONDS ?? '3600', 10)

    let res: SimpleResponse
    try {
      res = await lndFetch(`${this.baseUrl}/v1/invoices`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({
          value: amountSats,
          memo,
          expiry: expirySecs.toString(), // LND REST expects expiry as a string
        }),
      })
    } catch (err) {
      throw new LightningNodeError('LND', 'createInvoice', undefined, (err as Error).message)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LND', 'createInvoice', res.status, body)
    }

    const data = (await res.json()) as LNDCreateResponse

    // Decode r_hash: Buffer.from handles both standard and URL-safe base64
    const paymentHash = Buffer.from(data.r_hash, 'base64').toString('hex')
    const expiresAt = new Date(Date.now() + expirySecs * 1000)

    return {
      paymentHash,
      invoiceString: data.payment_request,
      amountSats,
      expiresAt,
    }
  }

  async getInvoiceStatus(paymentHash: string): Promise<InvoiceStatusResult> {
    // URL path requires URL-safe base64 (no padding, no + or / characters)
    const rHashBase64Url = Buffer.from(paymentHash, 'hex').toString('base64url')

    let res: SimpleResponse
    try {
      res = await lndFetch(`${this.baseUrl}/v1/invoice/${rHashBase64Url}`, {
        headers: this.authHeaders,
      })
    } catch (err) {
      throw new LightningNodeError('LND', 'getInvoiceStatus', undefined, (err as Error).message)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LND', 'getInvoiceStatus', res.status, body)
    }

    const data = (await res.json()) as LNDInvoiceResponse

    if (data.state === 'SETTLED') {
      const settledAt = data.settle_date
        ? new Date(parseInt(data.settle_date, 10) * 1000)
        : new Date()
      return { paymentHash, status: 'PAID', settledAt }
    }

    if (data.state === 'CANCELED') {
      return { paymentHash, status: 'EXPIRED' }
    }

    // OPEN = unpaid within TTL; ACCEPTED = hold invoice accepted, not yet settled
    return { paymentHash, status: 'PENDING' }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await lndFetch(`${this.baseUrl}/v1/getinfo`, {
        headers: this.authHeaders,
      })
      return res.ok
    } catch {
      return false
    }
  }

  async getBalance(): Promise<BalanceResult> {
    let res: SimpleResponse
    try {
      res = await lndFetch(`${this.baseUrl}/v1/balance/channels`, {
        headers: this.authHeaders,
      })
    } catch (err) {
      throw new LightningNodeError('LND', 'createInvoice', undefined, (err as Error).message)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LND', 'createInvoice', res.status, body)
    }
    const data = (await res.json()) as { local_balance?: { sat?: string } }
    return { balanceSats: parseInt(data.local_balance?.sat ?? '0', 10) }
  }

  async payInvoice(bolt11: string): Promise<PayoutResult> {
    let res: SimpleResponse
    try {
      res = await lndFetch(`${this.baseUrl}/v1/channels/transactions`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify({ payment_request: bolt11 }),
      })
    } catch (err) {
      throw new LightningNodeError('LND', 'createInvoice', undefined, (err as Error).message)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LND', 'createInvoice', res.status, body)
    }
    const data = (await res.json()) as { payment_hash?: string }
    return { paymentHash: data.payment_hash ?? '' }
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const webhookSecret = process.env.LND_WEBHOOK_SECRET

    if (!webhookSecret) {
      // Option A: polling only. No webhooks registered with LND → reject all POST attempts.
      return false
    }

    // Option B: HMAC-SHA256 webhook bridge
    const provided = headers['x-lnd-signature'] ?? ''
    if (!provided) return false

    const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex')

    try {
      return timingSafeEqual(
        Buffer.from(provided.toLowerCase(), 'hex'),
        Buffer.from(expected, 'hex'),
      )
    } catch {
      return false // provided was not valid hex
    }
  }
}
