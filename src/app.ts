import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { serveStatic } from '@hono/node-server/serve-static'
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
import apiV1 from './v1/index.js'
import type { AppEnv } from './types/index.js'

const app = new OpenAPIHono<AppEnv>()

app.use('*', logger())
app.use('/api/*', cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000', credentials: true }))
// The public API is consumed server-to-server, but publishable-key routes may be
// called directly from browsers for article metadata — allow any origin.
app.use('/v1/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

app.route('/api/auth', authRoutes)
app.route('/api/articles', articleRoutes)
app.route('/api/invoices', invoiceRoutes)
app.route('/api/publisher', publisherRoutes)
app.route('/api/publisher/payout', payoutRoutes)
app.route('/api/rates', ratesRoutes)
app.route('/webhooks', webhookRoutes)
app.route('/v1', apiV1)

// OpenAPI 3.1 spec, auto-generated at runtime from the /v1/ createRoute definitions.
app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'API Key',
  description: 'Your Zap secret key. Format: `Authorization: Bearer zap_sk_...`',
})

app.doc31('/api/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Zap API',
    version: '1.0.0',
    description: 'Embed Lightning paywalls into any application.',
    contact: { name: 'Zap Support', url: 'https://zap.pub/support' },
  },
  servers: [
    { url: 'https://api.zap.pub', description: 'Production' },
    { url: `http://localhost:${process.env.PORT ?? '3001'}`, description: 'Local development' },
  ],
})

// Interactive docs
app.get(
  '/docs',
  Scalar({
    url: '/api/openapi.json',
    theme: 'default',
    layout: 'classic',
    defaultHttpClient: { targetKey: 'node', clientKey: 'fetch' },
    hideModels: false,
    searchHotKey: 'k',
    title: 'Zap API Reference',
    customCss: `
      :root {
        --scalar-color-accent: #C8935A;
        --scalar-color-background-1: #FAF3E8;
      }
      .darkmode {
        --scalar-color-accent: #C8935A;
      }
    `,
  }),
)

// Developer portal — static docs site (Introduction, Quickstart, Authentication, Guides,
// Webhook events, Error codes, Changelog). Built from docs/*.md via `pnpm docs:build`.
app.get('/guide', (c) => c.redirect('/guide/introduction.html'))
app.use('/guide/*', serveStatic({ root: './public' }))

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
