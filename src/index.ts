import 'dotenv/config'
import { serve } from '@hono/node-server'
import { validateEnv } from './lib/env.js'
import { prisma } from './lib/prisma.js'
import { getRedis } from './lib/redis.js'
import { startWorker } from './jobs/worker.js'
import app from './app.js'

validateEnv()

const port = parseInt(process.env.PORT ?? '3001', 10)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[zap-api] listening on port ${info.port}`)
})

const shutdownWorker = await startWorker()

process.on('SIGTERM', () => {
  console.log('[api] SIGTERM — draining connections...')

  server.close(() => {
    Promise.all([shutdownWorker(), prisma.$disconnect(), getRedis().disconnect()])
      .then(() => {
        console.log('[api] shutdown complete')
        process.exit(0)
      })
      .catch((err) => {
        console.error('[api] shutdown error:', (err as Error).message)
        process.exit(1)
      })
  })

  setTimeout(() => {
    console.error('[api] forced exit after 10s graceful shutdown window')
    process.exit(1)
  }, 10_000).unref()
})
