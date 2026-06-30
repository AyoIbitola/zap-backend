// Webhook receiver — POST /webhooks/lightning
//
// [CONFIRM M5] LNbits webhook payload shape verified against live API 2026-06-28:
//   Webhook body is the same payment details object as GET /api/v1/payments/:hash -> details.
//   Top-level field: payment_hash (64-char hex). No HMAC signature header.
//   eventType used for dedup: "payment_received" (only event LNbits fires on this endpoint).

import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { getLightningProvider } from '../lightning/index.js'
import { confirmInvoice } from '../services/invoice.service.js'
import { InvoiceNotFoundError, InvalidInvoiceTransitionError } from '../types/errors.js'

const webhooks = new Hono()

webhooks.post('/lightning', async (c) => {
  // 1. Read raw body as Buffer BEFORE any JSON parsing (needed for signature verification)
  const arrayBuffer = await c.req.arrayBuffer()
  const rawBody = Buffer.from(arrayBuffer)

  // 2. Verify signature — LNbits: always true (no signing). Future: LND webhook bridge uses HMAC.
  const provider = getLightningProvider()
  const rawHeaders: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    rawHeaders[key] = value
  })

  const signatureValid = provider.verifyWebhookSignature(rawBody, rawHeaders)
  if (!signatureValid) {
    const safeHeaders = { ...rawHeaders }
    delete safeHeaders['authorization']
    delete safeHeaders['x-api-key']
    console.error('[webhook] signature verification failed. Headers:', safeHeaders)
    return c.json({ error: 'invalid_signature' }, 401)
  }

  // 3. Parse JSON from raw body
  let payload: unknown
  try {
    payload = JSON.parse(rawBody.toString('utf-8'))
  } catch {
    // Malformed body — return 200 to prevent retry spam
    console.error('[webhook] malformed JSON body')
    return c.json({ ok: true })
  }

  // 4. Extract payment_hash — confirmed field name from LNbits live API
  const parsed = z.object({ payment_hash: z.string().length(64).regex(/^[0-9a-f]+$/) }).safeParse(payload)
  if (!parsed.success) {
    console.error('[webhook] missing or invalid payment_hash in payload:', JSON.stringify(payload).slice(0, 200))
    return c.json({ ok: true })
  }

  const { payment_hash: paymentHash } = parsed.data
  const dedupKey = `${paymentHash}:payment_received`

  // 5. Deduplication check
  const existing = await prisma.webhookEvent.findUnique({ where: { dedupKey } })
  if (existing) {
    return c.json({ ok: true })
  }

  // 6. Persist WebhookEvent BEFORE processing — so retries are caught by dedup even if we crash
  try {
    await prisma.webhookEvent.create({
      // Cast via unknown: payload is already valid JSON, Prisma's InputJsonValue is a strict
      // recursive type that TypeScript can't infer from a parsed-JSON `unknown`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { dedupKey, rawPayload: payload as any },
    })
  } catch (err) {
    // P2002 = unique constraint violation — concurrent delivery already processed
    if ((err as { code?: string }).code === 'P2002') {
      return c.json({ ok: true })
    }
    console.error('[webhook] failed to persist event:', (err as Error).message)
    return c.json({ ok: true }) // Don't 500 — avoid triggering infinite retries
  }

  // 7. Confirm the invoice
  try {
    await confirmInvoice(paymentHash)
    console.log(`[webhook] confirmed: ${paymentHash.slice(0, 12)}…`)
  } catch (err) {
    if (err instanceof InvoiceNotFoundError) {
      console.log(`[webhook] stale event — invoice not found: ${paymentHash.slice(0, 12)}…`)
    } else if (err instanceof InvalidInvoiceTransitionError) {
      console.log(`[webhook] transition no-op (already settled): ${paymentHash.slice(0, 12)}…`)
    } else {
      console.error('[webhook] unexpected error confirming invoice:', (err as Error).message)
    }
  }

  // 8. Always 200 after signature passes — prevents node retry loops
  return c.json({ ok: true })
})

export default webhooks
