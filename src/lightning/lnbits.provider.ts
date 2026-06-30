// LNbits provider — confirmed against live demo.lnbits.com on 2026-06-28
//
// [CONFIRM 1] POST /api/v1/payments response (verified via real API call):
//   - payment_hash: 64-char hex string (top-level)
//   - payment_request: full BOLT11 string (same value also in "bolt11" field)
//   - amount: in MILLISATOSHIS — LNbits accepts sats in the request but returns msats.
//     We use the amountSats param we sent rather than dividing the response by 1000.
//   - expiry: ISO datetime string for the absolute expiry (PRD assumed seconds TTL — wrong).
//     Parse directly as Date instead of computing now() + seconds.
//   - checking_id: same as payment_hash on this instance
//
// [CONFIRM 2a] GET /api/v1/payments/<hash> UNPAID response (verified via real API call):
//   { "paid": false, "status": "pending", "preimage": null, "details": { ...full payment... } }
//
// [CONFIRM 2b] GET /api/v1/payments/<hash> PAID response (verified via source code):
//   { "paid": true, "preimage": "...", "details": { ...full payment... } }
//   NOTE: No "status" field at top level when paid. Detect by "paid": true only.
//   Settlement time: details.updated_at (ISO datetime string).
//
// [CONFIRM 3] Webhook signing: LNbits does NOT sign webhook payloads.
//   No HMAC or signature header is sent. Plain JSON POST.
//   Webhook body is the full payment object; payment_hash is top-level.
//   Protection relies on payment_hash DB lookup (PRD Section 5.2 fallback).

import type {
  LightningProvider,
  CreateInvoiceResult,
  InvoiceStatusResult,
  BalanceResult,
  PayoutResult,
} from './provider.interface.js'
import { LightningNodeError } from './provider.interface.js'

interface LNbitsCreateResponse {
  payment_hash: string
  payment_request: string
  expiry: string | number | null  // ISO datetime (real backend) or Unix seconds (FakeWallet)
  amount: number        // millisatoshis — confirmed above
  checking_id: string
}

interface LNbitsStatusResponse {
  paid: boolean
  status?: string       // present when paid=false ("pending"|"failed"), absent when paid=true
  preimage: string | null
  details?: {
    payment_hash: string
    updated_at?: string  // ISO datetime, populated when paid
  }
}

export class LNbitsProvider implements LightningProvider {
  private readonly baseUrl: string
  private readonly invoiceKey: string
  private readonly adminKey: string | undefined

  constructor() {
    this.baseUrl = process.env.LNBITS_BASE_URL!
    this.invoiceKey = process.env.LNBITS_INVOICE_KEY!
    this.adminKey = process.env.LNBITS_ADMIN_KEY
  }

  async createInvoice(amountSats: number, memo: string): Promise<CreateInvoiceResult> {
    const webhookBase = process.env.WEBHOOK_BASE_URL
    const expirySecs = parseInt(process.env.INVOICE_EXPIRY_SECONDS ?? '3600', 10)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.invoiceKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          out: false,
          amount: amountSats,  // LNbits accepts sats here
          memo,
          expiry: expirySecs,
          ...(webhookBase ? { webhook: `${webhookBase}/webhooks/lightning` } : {}),
        }),
      })
    } catch (err) {
      throw new LightningNodeError('LNBITS', 'createInvoice', undefined, (err as Error).message)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LNBITS', 'createInvoice', res.status, body)
    }

    const data = (await res.json()) as LNbitsCreateResponse

    // LNbits real backend returns expiry as ISO string without 'Z' suffix (UTC) — append 'Z'.
    // LNbits FakeWallet returns expiry as a Unix timestamp (seconds). Handle both.
    const expiresAt = data.expiry == null
      ? new Date(Date.now() + expirySecs * 1000)
      : typeof data.expiry === 'number'
        ? new Date(data.expiry * 1000)
        : new Date(String(data.expiry) + 'Z')

    return {
      paymentHash: data.payment_hash,
      invoiceString: data.payment_request,
      amountSats,
      expiresAt,
    }
  }

  async getInvoiceStatus(paymentHash: string): Promise<InvoiceStatusResult> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/payments/${paymentHash}`, {
        headers: { 'X-Api-Key': this.invoiceKey },
      })
    } catch (err) {
      throw new LightningNodeError('LNBITS', 'getInvoiceStatus', undefined, (err as Error).message)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LNBITS', 'getInvoiceStatus', res.status, body)
    }

    const data = (await res.json()) as LNbitsStatusResponse

    if (data.paid) {
      // Confirmed: paid=true has no "status" field. Use details.updated_at as settledAt.
      const settledAt = data.details?.updated_at ? new Date(data.details.updated_at) : new Date()
      return { paymentHash, status: 'PAID', settledAt }
    }

    // failed status = treat as expired (invoice rejected or TTL elapsed on node side)
    if (data.status === 'failed') {
      return { paymentHash, status: 'EXPIRED' }
    }

    return { paymentHash, status: 'PENDING' }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/wallet`, {
        headers: { 'X-Api-Key': this.invoiceKey },
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async getBalance(): Promise<BalanceResult> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/wallet`, {
        headers: { 'X-Api-Key': this.invoiceKey },
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      throw new LightningNodeError('LNBITS', 'createInvoice', undefined, (err as Error).message)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LNBITS', 'createInvoice', res.status, body)
    }
    const data = (await res.json()) as { balance: number }
    // LNbits wallet balance is in millisatoshis
    return { balanceSats: Math.floor(data.balance / 1000) }
  }

  async payInvoice(bolt11: string): Promise<PayoutResult> {
    if (!this.adminKey) {
      throw new LightningNodeError('LNBITS', 'createInvoice', 403, 'LNBITS_ADMIN_KEY not configured — payouts require the admin key')
    }
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/payments`, {
        method: 'POST',
        headers: { 'X-Api-Key': this.adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ out: true, bolt11 }),
        signal: AbortSignal.timeout(30000),
      })
    } catch (err) {
      throw new LightningNodeError('LNBITS', 'createInvoice', undefined, (err as Error).message)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new LightningNodeError('LNBITS', 'createInvoice', res.status, body)
    }
    const data = (await res.json()) as { payment_hash: string }
    return { paymentHash: data.payment_hash }
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    // Confirmed: LNbits sends no signature header. Always return true here.
    // Protection against arbitrary POSTs comes from InvoiceService.confirm()
    // throwing InvoiceNotFoundError if the payment_hash has no matching DB row.
    void rawBody
    void headers
    return true
  }
}
