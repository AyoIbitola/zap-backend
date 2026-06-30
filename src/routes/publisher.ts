import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { getLightningProvider } from '../lightning/index.js'
import { LightningNodeError } from '../lightning/provider.interface.js'
import { publisherAuth } from '../middleware/auth.js'
import type { AppEnv } from '../types/index.js'

const publisher = new Hono<AppEnv>()

publisher.use('*', publisherAuth)

// ─── GET /api/publisher/articles ─────────────────────────────────────────────
publisher.get('/articles', async (c) => {
  const { publisherId } = c.get('publisher')

  const articles = await prisma.article.findMany({
    where: { publisherId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      slug: true,
      subtitle: true,
      topicTag: true,
      featured: true,
      published: true,
      publishedAt: true,
      priceSats: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  if (articles.length === 0) {
    return c.json({ articles: [] })
  }

  const articleIds = articles.map((a) => a.id)

  const [paidStats, pendingStats] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['articleId'],
      where: { articleId: { in: articleIds }, status: 'PAID' },
      _count: { id: true },
      _sum: { amountSats: true },
    }),
    prisma.invoice.groupBy({
      by: ['articleId'],
      where: { articleId: { in: articleIds }, status: 'PENDING' },
      _count: { id: true },
    }),
  ])

  const paidMap = new Map(paidStats.map((s) => [s.articleId, s]))
  const pendingMap = new Map(pendingStats.map((s) => [s.articleId, s]))

  const result = articles.map((a) => ({
    ...a,
    stats: {
      totalRevenueSats: paidMap.get(a.id)?._sum.amountSats ?? 0,
      totalPaidInvoices: paidMap.get(a.id)?._count.id ?? 0,
      pendingInvoices: pendingMap.get(a.id)?._count.id ?? 0,
    },
  }))

  return c.json({ articles: result })
})

// ─── GET /api/publisher/articles/:id/invoices ─────────────────────────────────
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

publisher.get('/articles/:id/invoices', async (c) => {
  const { publisherId } = c.get('publisher')
  const articleId = c.req.param('id')

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { publisherId: true, title: true, priceSats: true },
  })

  if (!article) {
    return c.json({ error: 'not_found', message: 'Article not found' }, 404)
  }

  if (article.publisherId !== publisherId) {
    return c.json({ error: 'forbidden', message: 'You do not own this article' }, 403)
  }

  const parsed = pageSchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  })

  if (!parsed.success) {
    return c.json({ error: 'validation_error', message: parsed.error.errors[0]?.message ?? 'Invalid pagination params' }, 422)
  }

  const { page, limit } = parsed.data
  const skip = (page - 1) * limit

  const [invoices, total, paidAgg] = await Promise.all([
    prisma.invoice.findMany({
      where: { articleId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        paymentHash: true,
        status: true,
        amountSats: true,
        readerFingerprint: true,
        nodeProvider: true,
        createdAt: true,
        confirmedAt: true,
        expiresAt: true,
        pollAttempts: true,
      },
    }),
    prisma.invoice.count({ where: { articleId } }),
    prisma.invoice.aggregate({
      where: { articleId, status: 'PAID' },
      _count: { id: true },
      _sum: { amountSats: true },
    }),
  ])

  return c.json({
    invoices,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    stats: {
      totalRevenueSats: paidAgg._sum.amountSats ?? 0,
      totalPaidInvoices: paidAgg._count.id ?? 0,
      priceSats: article.priceSats,
    },
  })
})

// ─── GET /api/publisher/invoices — all invoices across all articles ───────────
publisher.get('/invoices', async (c) => {
  const { publisherId } = c.get('publisher')

  const parsed = pageSchema.safeParse({
    page: c.req.query('page'),
    limit: c.req.query('limit'),
  })

  if (!parsed.success) {
    return c.json({ error: 'validation_error', message: parsed.error.errors[0]?.message ?? 'Invalid pagination params' }, 422)
  }

  const { page, limit } = parsed.data
  const skip = (page - 1) * limit

  const statusFilter = c.req.query('status')
  const from = c.req.query('from')
  const to = c.req.query('to')

  const where: Record<string, unknown> = { article: { publisherId } }
  if (statusFilter && ['PAID', 'EXPIRED', 'PENDING', 'CANCELLED'].includes(statusFilter)) {
    where.status = statusFilter
  }
  if (from || to) {
    const dateFilter: Record<string, Date> = {}
    if (from) dateFilter.gte = new Date(from)
    if (to) dateFilter.lte = new Date(to)
    where.createdAt = dateFilter
  }

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        paymentHash: true,
        status: true,
        amountSats: true,
        createdAt: true,
        confirmedAt: true,
        article: { select: { id: true, title: true, slug: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ])

  return c.json({ invoices, total, page, limit, totalPages: Math.ceil(total / limit) })
})

// ─── GET /api/publisher/invoices/export ──────────────────────────────────────
publisher.get('/invoices/export', async (c) => {
  const { publisherId } = c.get('publisher')

  const invoices = await prisma.invoice.findMany({
    where: { article: { publisherId } },
    orderBy: { createdAt: 'desc' },
    take: 10000,
    select: {
      paymentHash: true,
      status: true,
      amountSats: true,
      createdAt: true,
      confirmedAt: true,
      article: { select: { title: true, slug: true } },
    },
  })

  const rows = [
    ['Payment Hash', 'Status', 'Amount (sats)', 'Article', 'Created At', 'Confirmed At'],
    ...invoices.map((inv) => [
      inv.paymentHash,
      inv.status,
      inv.status === 'PAID' ? inv.amountSats.toString() : '',
      inv.article.title,
      inv.createdAt.toISOString(),
      inv.confirmedAt?.toISOString() ?? '',
    ]),
  ]

  const csv = rows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n')

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="zap-invoices.csv"',
    },
  })
})

// ─── GET /api/publisher/stats ─────────────────────────────────────────────────
const PERIOD_MAP: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  'all': 0,
}

function periodStart(period: string): Date | undefined {
  const days = PERIOD_MAP[period] ?? 30
  if (days === 0) return undefined
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

publisher.get('/stats', async (c) => {
  const { publisherId } = c.get('publisher')
  const period = c.req.query('period') ?? '30d'
  const start = periodStart(period)

  const timeFilter = start ? { gte: start } : undefined

  const [currentStats, prevStats, articleCount, draftCount] = await Promise.all([
    prisma.invoice.aggregate({
      where: {
        article: { publisherId },
        status: 'PAID',
        ...(timeFilter ? { confirmedAt: timeFilter } : {}),
      },
      _count: { id: true },
      _sum: { amountSats: true },
    }),
    // Previous period for delta calculation
    start
      ? prisma.invoice.aggregate({
          where: {
            article: { publisherId },
            status: 'PAID',
            confirmedAt: {
              gte: new Date(start.getTime() - (Date.now() - start.getTime())),
              lt: start,
            },
          },
          _count: { id: true },
          _sum: { amountSats: true },
        })
      : Promise.resolve(null),
    prisma.article.count({ where: { publisherId, published: true } }),
    prisma.article.count({ where: { publisherId, published: false } }),
  ])

  const totalRevenueSats = currentStats._sum.amountSats ?? 0
  const totalPaidInvoices = currentStats._count.id ?? 0
  const avgPerArticle = articleCount > 0 ? Math.round(totalRevenueSats / articleCount) : 0

  const prevRevenue = prevStats?._sum.amountSats ?? 0
  const prevReads = prevStats?._count.id ?? 0
  const revenueDelta = prevRevenue > 0 ? Math.round(((totalRevenueSats - prevRevenue) / prevRevenue) * 100) : null
  const readsDelta = prevReads > 0 ? Math.round(((totalPaidInvoices - prevReads) / prevReads) * 100) : null

  return c.json({
    totalRevenueSats,
    totalPaidInvoices,
    totalArticles: articleCount,
    draftArticles: draftCount,
    avgPerArticleSats: avgPerArticle,
    revenueDeltaPercent: revenueDelta,
    readsDeltaPercent: readsDelta,
  })
})

// ─── GET /api/publisher/stats/chart ──────────────────────────────────────────
publisher.get('/stats/chart', async (c) => {
  const { publisherId } = c.get('publisher')
  const period = c.req.query('period') ?? '30d'
  const start = periodStart(period)

  const invoices = await prisma.invoice.findMany({
    where: {
      article: { publisherId },
      status: 'PAID',
      ...(start ? { confirmedAt: { gte: start } } : {}),
    },
    select: { amountSats: true, confirmedAt: true },
    orderBy: { confirmedAt: 'asc' },
  })

  // Group by date
  const grouped = new Map<string, number>()

  for (const inv of invoices) {
    if (!inv.confirmedAt) continue
    let key: string
    const d = inv.confirmedAt
    if (period === '7d' || period === '30d') {
      key = d.toISOString().slice(0, 10)
    } else if (period === '90d') {
      // group by week
      const weekStart = new Date(d)
      weekStart.setDate(d.getDate() - d.getDay())
      key = weekStart.toISOString().slice(0, 10)
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    }
    grouped.set(key, (grouped.get(key) ?? 0) + inv.amountSats)
  }

  // Fill in zero-value days for gaps
  const points: Array<{ date: string; revenueSats: number }> = []

  if (start && (period === '7d' || period === '30d')) {
    const days = PERIOD_MAP[period] ?? 30
    for (let i = 0; i < days; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      const key = d.toISOString().slice(0, 10)
      points.push({ date: key, revenueSats: grouped.get(key) ?? 0 })
    }
  } else {
    for (const [date, revenueSats] of grouped) {
      points.push({ date, revenueSats })
    }
    points.sort((a, b) => a.date.localeCompare(b.date))
  }

  return c.json(points)
})

// ─── GET /api/publisher/balance ───────────────────────────────────────────────
publisher.get('/balance', async (c) => {
  try {
    const provider = getLightningProvider()
    const result = await provider.getBalance()
    return c.json(result)
  } catch (err) {
    if (err instanceof LightningNodeError) {
      return c.json({ error: 'payment_unavailable', message: 'Lightning node is unreachable' }, 503)
    }
    throw err
  }
})

// ─── GET /api/publisher/node-status ──────────────────────────────────────────
publisher.get('/node-status', async (c) => {
  try {
    const provider = getLightningProvider()
    const reachable = await provider.checkHealth()
    const providerName = process.env.LIGHTNING_PROVIDER ?? 'LNBITS'
    const baseUrl = providerName === 'LNBITS'
      ? process.env.LNBITS_BASE_URL
      : process.env.LND_BASE_URL

    return c.json({ reachable, provider: providerName, baseUrl })
  } catch {
    return c.json({ reachable: false, provider: process.env.LIGHTNING_PROVIDER ?? 'LNBITS', baseUrl: null })
  }
})

// ─── POST /api/publisher/node-test ───────────────────────────────────────────
publisher.post('/node-test', async (c) => {
  try {
    const provider = getLightningProvider()
    const reachable = await provider.checkHealth()
    return c.json({ reachable })
  } catch {
    return c.json({ reachable: false })
  }
})

// ─── PATCH /api/publisher/settings ───────────────────────────────────────────
publisher.patch('/settings', async (c) => {
  // Settings (node credentials, etc.) are env-var based in this implementation.
  // This endpoint is a no-op stub that acknowledges the request — actual credential
  // changes require a server restart with updated env vars.
  return c.json({ success: true })
})

export default publisher
