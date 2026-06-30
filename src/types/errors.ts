export class ArticleNotPublishedError extends Error {
  constructor(articleId: string) {
    super(`Article ${articleId} not found or not published`)
    this.name = 'ArticleNotPublishedError'
  }
}

export class InvalidInvoiceTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid invoice transition: ${from} → ${to}`)
    this.name = 'InvalidInvoiceTransitionError'
  }
}

export class InvoiceNotFoundError extends Error {
  constructor(paymentHash: string) {
    super(`Invoice not found for payment hash: ${paymentHash}`)
    this.name = 'InvoiceNotFoundError'
  }
}
