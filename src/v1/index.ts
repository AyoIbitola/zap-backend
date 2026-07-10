import { OpenAPIHono } from '@hono/zod-openapi'
import keysRoutes from './routes/keys.js'
import articlesRoutes from './routes/articles.js'
import invoicesRoutes from './routes/invoices.js'
import webhooksRoutes from './routes/webhooks.js'
import analyticsRoutes from './routes/analytics.js'
import type { V1Env } from './types.js'

export const apiV1 = new OpenAPIHono<V1Env>()

apiV1.use('*', async (c, next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  c.res.headers.set('X-Request-Id', requestId)
  await next()
})

apiV1.use('*', async (c, next) => {
  await next()
  console.log(
    `[v1] ${c.req.method} ${c.req.path} status=${c.res.status} requestId=${c.get('requestId')} key=${c.get('keyPrefix') ?? 'n/a'}`,
  )
})

apiV1.route('/', keysRoutes)
apiV1.route('/', articlesRoutes)
apiV1.route('/', invoicesRoutes)
apiV1.route('/', webhooksRoutes)
apiV1.route('/', analyticsRoutes)

export default apiV1
