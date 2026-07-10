import type { Job } from 'bullmq'
import { prisma } from '../../lib/prisma.js'
import { deliverWebhookOnce } from '../deliverWebhookOnce.js'

export interface DeliverWebhookJobData {
  endpointId: string
  event: string
  payload: Record<string, unknown>
}

export async function handleDeliverWebhook(job: Job<DeliverWebhookJobData>): Promise<void> {
  const { endpointId, event, payload } = job.data

  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } })
  if (!endpoint || !endpoint.enabled) {
    console.log(`[webhook-delivery] endpoint ${endpointId} missing or disabled — discarding job`)
    return
  }

  const attemptNumber = job.attemptsMade + 1
  const result = await deliverWebhookOnce(endpoint, event, payload, attemptNumber)

  console.log(
    `[webhook-delivery] ${event} -> ${endpoint.url} attempt=${attemptNumber} status=${result.responseStatus ?? 'timeout'} delivered=${result.delivered}`,
  )

  if (!result.delivered) {
    // Throwing triggers BullMQ's configured retry/backoff.
    throw new Error(`Delivery failed: HTTP ${result.responseStatus ?? 'timeout'}`)
  }
}
