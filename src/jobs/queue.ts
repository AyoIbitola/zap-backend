// Pass plain connection options to BullMQ instead of an ioredis instance.
// This avoids a TypeScript type conflict caused by BullMQ bundling its own ioredis version
// (5.10.1) while the app uses ioredis 5.11.1 — the two Redis class shapes are incompatible at
// the type level even though they are runtime-compatible.
import { Queue } from 'bullmq'

function makeBullMQConnection() {
  const url = new URL(process.env.REDIS_URL!)
  return {
    host: url.hostname,
    port: parseInt(url.port, 10),
    password: url.password || undefined,
    username: url.username || undefined,
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
  }
}

export const invoicePollingQueue = new Queue('invoice-polling', {
  connection: makeBullMQConnection(),
})

export const invoiceSweepQueue = new Queue('invoice-sweep', {
  connection: makeBullMQConnection(),
})

// Exponential backoff from a 5s base, 5 attempts total before landing in the dead letter queue.
export const webhookDeliveryQueue = new Queue('webhook-delivery', {
  connection: makeBullMQConnection(),
  defaultJobOptions: {
    attempts: parseInt(process.env.WEBHOOK_MAX_RETRY_ATTEMPTS ?? '5', 10),
    backoff: { type: 'exponential', delay: 5000 },
  },
})
