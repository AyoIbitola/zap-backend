import 'dotenv/config'
import { Worker } from 'bullmq'
import { invoiceSweepQueue } from './queue.js'
import { handlePollInvoice } from './handlers/pollInvoice.js'
import { handleExpireInvoices } from './handlers/expireInvoices.js'

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

export async function startWorker() {
  const pollWorker = new Worker(
    'invoice-polling',
    async (job) => handlePollInvoice(job as Parameters<typeof handlePollInvoice>[0]),
    { connection: makeBullMQConnection(), concurrency: 5 },
  )

  const sweepWorker = new Worker(
    'invoice-sweep',
    async () => handleExpireInvoices(),
    { connection: makeBullMQConnection(), concurrency: 1 },
  )

  pollWorker.on('failed', (job, err) => {
    if (job && err.message !== 'Invoice still pending — retry') {
      console.error(`[poll] job ${job.id} failed:`, err.message)
    }
  })

  sweepWorker.on('failed', (job, err) => {
    console.error(`[sweep] job ${job?.id} failed:`, err.message)
  })

  await invoiceSweepQueue.upsertJobScheduler(
    'expire-invoices-cron',
    { every: 60_000 },
    { name: 'ExpireInvoices', data: {} },
  )

  console.log('[worker] invoice-polling and invoice-sweep workers started')
  console.log('[worker] ExpireInvoices cron registered (every 60s)')

  return async function shutdown() {
    console.log('[worker] shutting down — draining jobs...')
    await pollWorker.close()
    await sweepWorker.close()
    console.log('[worker] shutdown complete')
  }
}

// Allow running as standalone process: node dist/src/jobs/worker.js
if (process.argv[1]?.endsWith('worker.js') || process.argv[1]?.endsWith('worker.ts')) {
  const shutdown = await startWorker()
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)))
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)))
}
