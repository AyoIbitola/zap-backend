import crypto from 'node:crypto'
import type { Prisma, WebhookEndpoint } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { signPayload } from '../lib/webhookSignature.js'

export interface WebhookDeliveryResult {
  delivered: boolean
  responseStatus: number | null
  responseBody: string | null
  durationMs: number
}

// Performs one delivery attempt and persists the WebhookDelivery record. Shared by the
// queued/retried job handler and the synchronous POST /v1/webhooks/:id/test endpoint.
export async function deliverWebhookOnce(
  endpoint: Pick<WebhookEndpoint, 'id' | 'url' | 'secret'>,
  event: string,
  payload: Record<string, unknown>,
  attemptNumber: number,
): Promise<WebhookDeliveryResult> {
  const evtId = `evt_${crypto.randomUUID()}`
  const timestamp = Math.floor(Date.now() / 1000)
  const rawBody = JSON.stringify({ id: evtId, event, createdAt: new Date().toISOString(), data: payload })
  const signature = signPayload(endpoint.secret, evtId, timestamp, rawBody)

  const start = Date.now()
  let responseStatus: number | null = null
  let responseBody: string | null = null
  let delivered = false

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Zap-Webhook-Id': evtId,
        'Zap-Webhook-Timestamp': String(timestamp),
        'Zap-Webhook-Signature': signature,
        'User-Agent': 'Zap-Webhooks/1.0',
      },
      body: rawBody,
      signal: AbortSignal.timeout(parseInt(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS ?? '10000', 10)),
    })

    responseStatus = res.status
    responseBody = await res.text().then((t) => t.slice(0, 1000))
    delivered = res.ok
  } catch {
    // Network error or timeout — responseStatus/responseBody stay null.
  }

  const durationMs = Date.now() - start

  await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      event,
      payload: payload as Prisma.InputJsonValue,
      responseStatus,
      responseBody,
      durationMs,
      attemptNumber,
      status: delivered ? 'SUCCESS' : 'FAILED',
      deliveredAt: delivered ? new Date() : null,
    },
  })

  return { delivered, responseStatus, responseBody, durationMs }
}
