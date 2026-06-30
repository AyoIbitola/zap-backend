import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prisma } from './lib/prisma.js'
import { getRedis } from './lib/redis.js'
import { getLightningProvider } from './lightning/index.js'
import authRoutes from './routes/auth.js'
import articleRoutes from './routes/articles.js'
import invoiceRoutes from './routes/invoices.js'
import publisherRoutes from './routes/publisher.js'
import webhookRoutes from './routes/webhooks.js'
import ratesRoutes from './routes/rates.js'
import payoutRoutes from './routes/payouts.js'
import type { AppEnv } from './types/index.js'

const app = new Hono<AppEnv>()

app.use('*', logger())
app.use('/api/*', cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000', credentials: true }))

app.route('/api/auth', authRoutes)
app.route('/api/articles', articleRoutes)
app.route('/api/invoices', invoiceRoutes)
app.route('/api/publisher', publisherRoutes)
app.route('/api/publisher/payout', payoutRoutes)
app.route('/api/rates', ratesRoutes)
app.route('/webhooks', webhookRoutes)

app.get('/health', async (c) => {
  const h = {
    db: 'error' as 'connected' | 'error',
    redis: 'error' as 'connected' | 'error',
    lightning: 'unreachable' as 'reachable' | 'unreachable',
  }

  await Promise.all([
    prisma.$queryRaw`SELECT 1`
      .then(() => { h.db = 'connected' })
      .catch((err: Error) => { console.error('[health] db check failed:', err.message) }),

    getRedis().ping()
      .then(() => { h.redis = 'connected' })
      .catch((err: Error) => { console.error('[health] redis check failed:', err.message) }),

    getLightningProvider().checkHealth()
      .then((ok) => { h.lightning = ok ? 'reachable' : 'unreachable' })
      .catch((err: Error) => { console.error('[health] lightning check failed:', err.message) }),
  ])

  const allOk = h.db === 'connected' && h.redis === 'connected' && h.lightning === 'reachable'

  return c.json(
    { status: allOk ? 'ok' : 'degraded', db: h.db, redis: h.redis, lightning: h.lightning },
    allOk ? 200 : 503,
  )
})

app.notFound((c) => c.json({ error: 'not_found', message: 'Route not found' }, 404))

app.onError((err, c) => {
  console.error('[unhandled error]', err.message)
  return c.json({ error: 'internal_error', message: 'An unexpected error occurred' }, 500)
})

export default app
