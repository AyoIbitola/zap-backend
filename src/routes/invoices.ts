import { Hono } from 'hono'
import { z } from 'zod'
import {
  createInvoice,
  getInvoiceStatus,
} from '../services/invoice.service.js'
import {
  ArticleNotPublishedError,
} from '../types/errors.js'
import { LightningNodeError } from '../lightning/provider.interface.js'
import { rateLimit, checkRateLimit } from '../middleware/rateLimit.js'

const invoices = new Hono()

const createSchema = z.object({
  articleId: z.string().uuid(),
  readerFingerprint: z.string().min(1).max(256),
})

// POST /api/invoices — create invoice (public, called by readers)
invoices.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const result = createSchema.safeParse(body)
  if (!result.success) {
    return c.json(
      { error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' },
      422,
    )
  }

  const { articleId, readerFingerprint } = result.data

  // 5 invoice requests per reader fingerprint per minute
  const rl = await checkRateLimit(`invoice:fp:${readerFingerprint}`, 5, 60_000)
  if (!rl.allowed) {
    c.header('Retry-After', Math.ceil(rl.retryAfterMs / 1000).toString())
    return c.json({ error: 'rate_limited', message: 'Too many invoice requests. Try again shortly.' }, 429)
  }

  try {
    const invoice = await createInvoice(articleId, readerFingerprint)
    return c.json(invoice, 201)
  } catch (err) {
    if (err instanceof ArticleNotPublishedError) {
      return c.json({ error: 'not_found', message: 'Article not found or not published' }, 404)
    }
    if (err instanceof LightningNodeError) {
      console.error('[invoices] lightning node error:', err.operation, err.statusCode, err.upstreamMessage)
      return c.json(
        { error: 'payment_unavailable', message: 'Lightning node is unreachable. Try again shortly.' },
        503,
      )
    }
    throw err
  }
})

// GET /api/invoices/:paymentHash/status — reader polls for payment confirmation
// 30 requests per IP per minute
invoices.get('/:paymentHash/status', rateLimit({ limit: 30, windowMs: 60_000 }), async (c) => {
  const paymentHash = c.req.param('paymentHash')

  if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
    return c.json({ error: 'invalid_payment_hash', message: 'Payment hash must be a 64-char hex string' }, 400)
  }

  const status = await getInvoiceStatus(paymentHash)

  if (!status) {
    return c.json({ error: 'not_found', message: 'Invoice not found' }, 404)
  }

  return c.json(status)
})

export default invoices
