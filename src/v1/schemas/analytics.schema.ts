import { z } from '@hono/zod-openapi'

export const RevenueQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all']).optional().default('30d'),
  granularity: z.enum(['day', 'week']).optional().default('day'),
})

export const RevenueResponseSchema = z
  .object({
    period: z.enum(['7d', '30d', '90d', 'all']),
    totalRevenueSats: z.number().int(),
    totalPaidInvoices: z.number().int(),
    series: z.array(
      z.object({
        date: z.string(),
        revenueSats: z.number().int(),
        paidInvoices: z.number().int(),
      }),
    ),
  })
  .openapi('RevenueAnalyticsResponse')

export const ArticleAnalyticsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.enum(['revenue', 'reads']).optional().default('revenue'),
})

export const ArticleAnalyticsResponseSchema = z
  .object({
    articles: z.array(
      z.object({
        id: z.string().uuid(),
        title: z.string(),
        priceSats: z.number().int(),
        totalRevenueSats: z.number().int(),
        totalPaidInvoices: z.number().int(),
        conversionRate: z.number(),
      }),
    ),
  })
  .openapi('ArticleAnalyticsResponse')
