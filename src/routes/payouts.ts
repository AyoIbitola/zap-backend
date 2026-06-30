import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { getLightningProvider } from '../lightning/index.js'
import { LightningNodeError } from '../lightning/provider.interface.js'
import { publisherAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types/index.js'

const payouts = new Hono<AppEnv>()

payouts.use('*', publisherAuth)

// POST /api/publisher/payout — request a payout by paying a BOLT11 invoice
payouts.post('/', async (c) => {
  const { publisherId } = c.get('publisher')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const schema = z.object({
    amountSats: z.number().int().min(1),
    invoice: z.string().min(1),
  })

  const result = schema.safeParse(body)
  if (!result.success) {
    return c.json({ error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' }, 422)
  }

  const { amountSats, invoice } = result.data

  // Create payout record
  const payout = await prisma.payoutRequest.create({
    data: { publisherId, amountSats, invoice, status: 'PROCESSING' },
  })

  try {
    const provider = getLightningProvider()
    const payResult = await provider.payInvoice(invoice)

    await prisma.payoutRequest.update({
      where: { id: payout.id },
      data: { status: 'PAID', paymentHash: payResult.paymentHash },
    })

    return c.json({
      id: payout.id,
      status: 'PAID',
      paymentHash: payResult.paymentHash,
      amountSats,
    })
  } catch (err) {
    const message = err instanceof LightningNodeError
      ? (err.upstreamMessage ?? 'Payment failed')
      : 'Payment failed'

    await prisma.payoutRequest.update({
      where: { id: payout.id },
      data: { status: 'FAILED', error: message },
    })

    if (err instanceof LightningNodeError) {
      return c.json({ error: 'payment_failed', message }, 503)
    }
    throw err
  }
})

// GET /api/publisher/payout/:id/status
payouts.get('/:id/status', async (c) => {
  const { publisherId } = c.get('publisher')
  const id = c.req.param('id')

  const payout = await prisma.payoutRequest.findUnique({ where: { id } })

  if (!payout) {
    return c.json({ error: 'not_found', message: 'Payout not found' }, 404)
  }

  if (payout.publisherId !== publisherId) {
    return c.json({ error: 'forbidden', message: 'Access denied' }, 403)
  }

  return c.json({
    id: payout.id,
    status: payout.status,
    amountSats: payout.amountSats,
    paymentHash: payout.paymentHash,
    error: payout.error,
    createdAt: payout.createdAt,
  })
})

export default payouts
