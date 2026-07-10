import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { prisma } from '../../lib/prisma.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'
import { requireScope } from '../middleware/requireScope.js'
import { rateLimitGroup } from '../middleware/rateLimit.js'
import { zodErrorHook } from '../lib/validationHook.js'
import { RevenueQuerySchema, RevenueResponseSchema, ArticleAnalyticsQuerySchema, ArticleAnalyticsResponseSchema } from '../schemas/analytics.schema.js'
import { ErrorSchema } from '../schemas/error.schema.js'
import type { V1Env } from '../types.js'

const analytics = new OpenAPIHono<V1Env>({ defaultHook: zodErrorHook })

analytics.use(
  '*',
  rateLimitGroup([
    { name: 'analytics-read', test: (c) => c.req.method === 'GET' && c.req.path.startsWith('/v1/analytics'), limit: 30, windowMs: 60_000 },
  ]),
)
analytics.use('*', apiKeyAuth)

const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, all: 0 }

function periodStart(period: string): Date | undefined {
  const days = PERIOD_DAYS[period] ?? 30
  if (days === 0) return undefined
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

// ─── GET /v1/analytics/revenue ────────────────────────────────────────────────────

const revenueRoute = createRoute({
  method: 'get',
  path: '/analytics/revenue',
  tags: ['Analytics'],
  summary: 'Revenue Time Series',
  description: 'Revenue and paid-invoice counts over time, bucketed by day or week. Matches the totals shown in the Zap dashboard.',
  security: [{ ApiKeyAuth: ['analytics:read'] }],
  middleware: [requireScope('analytics:read')] as const,
  request: { query: RevenueQuerySchema },
  responses: {
    200: { description: 'Revenue series', content: { 'application/json': { schema: RevenueResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the analytics:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

analytics.openapi(revenueRoute, async (c) => {
  const { period, granularity } = c.req.valid('query')
  const publisherId = c.get('publisherId')
  const start = periodStart(period)

  const paidInvoices = await prisma.invoice.findMany({
    where: {
      article: { publisherId },
      status: 'PAID',
      ...(start ? { confirmedAt: { gte: start } } : {}),
    },
    select: { amountSats: true, confirmedAt: true },
  })

  const grouped = new Map<string, { revenueSats: number; paidInvoices: number }>()

  for (const inv of paidInvoices) {
    if (!inv.confirmedAt) continue
    let key: string
    if (granularity === 'week') {
      const weekStart = new Date(inv.confirmedAt)
      weekStart.setUTCDate(inv.confirmedAt.getUTCDate() - inv.confirmedAt.getUTCDay())
      key = weekStart.toISOString().slice(0, 10)
    } else {
      key = inv.confirmedAt.toISOString().slice(0, 10)
    }
    const bucket = grouped.get(key) ?? { revenueSats: 0, paidInvoices: 0 }
    bucket.revenueSats += inv.amountSats
    bucket.paidInvoices += 1
    grouped.set(key, bucket)
  }

  const series: Array<{ date: string; revenueSats: number; paidInvoices: number }> = []

  if (start && granularity === 'day') {
    // Walk from the start date through today's date inclusive — a fixed iteration count
    // derived from `period` would stop one day short of today (an off-by-one on the
    // partial current day), silently dropping today's revenue from the series.
    const now = new Date()
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    while (cursor <= endDate) {
      const key = cursor.toISOString().slice(0, 10)
      const bucket = grouped.get(key)
      series.push({ date: key, revenueSats: bucket?.revenueSats ?? 0, paidInvoices: bucket?.paidInvoices ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  } else {
    for (const [date, bucket] of grouped) series.push({ date, ...bucket })
    series.sort((a, b) => a.date.localeCompare(b.date))
  }

  const totalRevenueSats = paidInvoices.reduce((sum, inv) => sum + inv.amountSats, 0)

  return c.json({ period, totalRevenueSats, totalPaidInvoices: paidInvoices.length, series }, 200)
})

// ─── GET /v1/analytics/articles ───────────────────────────────────────────────────

const articleAnalyticsRoute = createRoute({
  method: 'get',
  path: '/analytics/articles',
  tags: ['Analytics'],
  summary: 'Per-Article Performance',
  description: 'Revenue, paid-invoice count, and conversion rate per article, sorted by revenue or read count.',
  security: [{ ApiKeyAuth: ['analytics:read'] }],
  middleware: [requireScope('analytics:read')] as const,
  request: { query: ArticleAnalyticsQuerySchema },
  responses: {
    200: { description: 'Per-article analytics', content: { 'application/json': { schema: ArticleAnalyticsResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the analytics:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

analytics.openapi(articleAnalyticsRoute, async (c) => {
  const { limit, sort } = c.req.valid('query')
  const publisherId = c.get('publisherId')

  const articleList = await prisma.article.findMany({
    where: { publisherId },
    select: { id: true, title: true, priceSats: true },
  })
  const articleIds = articleList.map((a) => a.id)

  if (articleIds.length === 0) {
    return c.json({ articles: [] }, 200)
  }

  const [paidStats, totalStats] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['articleId'],
      where: { articleId: { in: articleIds }, status: 'PAID' },
      _count: { id: true },
      _sum: { amountSats: true },
    }),
    prisma.invoice.groupBy({
      by: ['articleId'],
      where: { articleId: { in: articleIds } },
      _count: { id: true },
    }),
  ])

  const paidMap = new Map(paidStats.map((s) => [s.articleId, s]))
  const totalMap = new Map(totalStats.map((s) => [s.articleId, s._count.id]))

  const results = articleList.map((a) => {
    const totalRevenueSats = paidMap.get(a.id)?._sum.amountSats ?? 0
    const totalPaidInvoices = paidMap.get(a.id)?._count.id ?? 0
    const totalGenerated = totalMap.get(a.id) ?? 0
    const conversionRate = totalGenerated > 0 ? totalPaidInvoices / totalGenerated : 0

    return { id: a.id, title: a.title, priceSats: a.priceSats, totalRevenueSats, totalPaidInvoices, conversionRate }
  })

  results.sort((a, b) => (sort === 'reads' ? b.totalPaidInvoices - a.totalPaidInvoices : b.totalRevenueSats - a.totalRevenueSats))

  return c.json({ articles: results.slice(0, limit) }, 200)
})

export default analytics
