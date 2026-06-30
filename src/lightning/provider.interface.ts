export interface CreateInvoiceResult {
  paymentHash: string    // 64-char hex string
  invoiceString: string  // full BOLT11 string
  amountSats: number
  expiresAt: Date        // absolute expiry
}

export interface InvoiceStatusResult {
  paymentHash: string
  status: 'PENDING' | 'PAID' | 'EXPIRED'
  settledAt?: Date       // present only when status is PAID
}

export interface BalanceResult {
  balanceSats: number
}

export interface PayoutResult {
  paymentHash: string
}

export interface LightningProvider {
  createInvoice(amountSats: number, memo: string): Promise<CreateInvoiceResult>
  getInvoiceStatus(paymentHash: string): Promise<InvoiceStatusResult>
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean
  /** Lightweight reachability check for the /health endpoint. */
  checkHealth(): Promise<boolean>
  /** Returns wallet balance in sats. */
  getBalance(): Promise<BalanceResult>
  /** Pays a BOLT11 invoice from the publisher's wallet. Requires admin/payment credentials. */
  payInvoice(bolt11: string): Promise<PayoutResult>
}

export class LightningNodeError extends Error {
  constructor(
    public readonly provider: 'LNBITS' | 'LND',
    public readonly operation: 'createInvoice' | 'getInvoiceStatus',
    public readonly statusCode?: number,
    public readonly upstreamMessage?: string,
    message?: string,
  ) {
    super(message ?? `Lightning node error: ${operation}`)
    this.name = 'LightningNodeError'
  }
}
