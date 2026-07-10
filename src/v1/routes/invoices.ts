import crypto from 'node:crypto'
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { prisma } from '../../lib/prisma.js'
import { getRedis } from '../../lib/redis.js'
import { createInvoice } from '../../services/invoice.service.js'
import { validateAccessTokenDetailed } from '../../services/accessToken.service.js'
import { LightningNodeError } from '../../lightning/provider.interface.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'
import { requireScope } from '../middleware/requireScope.js'
import { rateLimitGroup } from '../middleware/rateLimit.js'
import { errorResponse } from '../lib/errorResponse.js'
import { zodErrorHook } from '../lib/validationHook.js'
import {
  CreateInvoiceSchema,
  InvoiceCreateResponseSchema,
  PaymentHashParamSchema,
  InvoiceStatusResponseSchema,
  VerifyAccessTokenSchema,
  VerifyAccessTokenResponseSchema,
  InvoiceListQuerySchema,
  InvoiceListResponseSchema,
} from '../schemas/invoice.schema.js'
import { ErrorSchema, ValidationErrorSchema } from '../schemas/error.schema.js'
import type { V1Env } from '../types.js'

const invoices = new OpenAPIHono<V1Env>({ defaultHook: zodErrorHook })

invoices.use(
  '*',
  rateLimitGroup([
    { name: 'invoices-create', test: (c) => c.req.method === 'POST' && c.req.path === '/v1/invoices', limit: 60, windowMs: 60_000 },
    { name: 'invoices-read', test: (c) => c.req.method === 'GET' && c.req.path.startsWith('/v1/invoices'), limit: 120, windowMs: 60_000 },
  ]),
)
invoices.use('*', apiKeyAuth)

// ─── POST /v1/invoices ──────────────────────────────────────────────────────────

const createInvoiceRoute = createRoute({
  method: 'post',
  path: '/invoices',
  tags: ['Invoices'],
  summary: 'Generate A Lightning Invoice',
  description:
    'Creates a BOLT11 Lightning invoice for one of your published articles. ' +
    'The reader scans the returned QR code and pays. Poll `GET /v1/invoices/{paymentHash}` every 2 seconds, ' +
    'or register a webhook, to detect payment.',
  security: [{ ApiKeyAuth: ['invoices:create'] }],
  middleware: [requireScope('invoices:create')] as const,
  request: { body: { content: { 'application/json': { schema: CreateInvoiceSchema } }, required: true } },
  responses: {
    201: { description: 'Invoice created', content: { 'application/json': { schema: InvoiceCreateResponseSchema } } },
    400: { description: 'Article is not published', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the invoices:create scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Article not found or not owned by this publisher', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure', content: { 'application/json': { schema: ValidationErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
    503: { description: 'Lightning node unreachable', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

invoices.openapi(createInvoiceRoute, async (c) => {
  const { articleId, readerFingerprint } = c.req.valid('json')
  const publisherId = c.get('publisherId')

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, publisherId: true, published: true },
  })

  if (!article || article.publisherId !== publisherId) {
    return errorResponse(c, 404, 'article_not_found', 'Article not found or not owned by this publisher.')
  }
  if (!article.published) {
    return errorResponse(c, 400, 'article_not_published', 'Article exists but is not published.')
  }

  const fingerprint = readerFingerprint ?? `api_${crypto.randomUUID()}`

  try {
    const invoice = await createInvoice(articleId, fingerprint)
    return c.json(
      {
        paymentHash: invoice.paymentHash,
        invoiceString: invoice.invoiceString,
        amountSats: invoice.amountSats,
        expiresAt: invoice.expiresAt.toISOString(),
        status: 'PENDING' as const,
      },
      201,
    )
  } catch (err) {
    if (err instanceof LightningNodeError) {
      console.error('[v1/invoices] lightning node error:', err.operation, err.statusCode, err.upstreamMessage)
      return errorResponse(c, 503, 'lightning_unavailable', 'Lightning node is unreachable. Try again shortly.')
    }
    throw err
  }
})

// ─── GET /v1/invoices/:paymentHash ───────────────────────────────────────────────

const getInvoiceRoute = createRoute({
  method: 'get',
  path: '/invoices/{paymentHash}',
  tags: ['Invoices'],
  summary: 'Check Invoice Status',
  description:
    'Checks payment status for an invoice. When `status` is `PAID`, `accessToken` is included only within ' +
    '60 seconds of confirmation — store it from the first PAID response or from the `invoice.paid` webhook.',
  security: [{ ApiKeyAuth: ['invoices:read'] }],
  middleware: [requireScope('invoices:read')] as const,
  request: { params: PaymentHashParamSchema },
  responses: {
    200: { description: 'Invoice status', content: { 'application/json': { schema: InvoiceStatusResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the invoices:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Payment hash not found', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

invoices.openapi(getInvoiceRoute, async (c) => {
  const { paymentHash } = c.req.valid('param')
  const publisherId = c.get('publisherId')

  const invoice = await prisma.invoice.findUnique({
    where: { paymentHash },
    include: { article: { select: { publisherId: true } }, accessToken: { select: { tokenHash: true } } },
  })

  if (!invoice || invoice.article.publisherId !== publisherId) {
    return errorResponse(c, 404, 'invoice_not_found', 'Payment hash not found.')
  }

  let accessToken: string | undefined
  if (invoice.status === 'PAID' && invoice.accessToken) {
    const stored = await getRedis().get(`jwt:${invoice.accessToken.tokenHash}`)
    accessToken = stored ?? undefined
  }

  return c.json(
    {
      paymentHash: invoice.paymentHash,
      status: invoice.status,
      amountSats: invoice.amountSats,
      articleId: invoice.articleId,
      createdAt: invoice.createdAt.toISOString(),
      expiresAt: invoice.expiresAt.toISOString(),
      confirmedAt: invoice.confirmedAt ? invoice.confirmedAt.toISOString() : null,
      ...(accessToken ? { accessToken } : {}),
    },
    200,
  )
})

// ─── POST /v1/invoices/:paymentHash/verify ───────────────────────────────────────

const verifyRoute = createRoute({
  method: 'post',
  path: '/invoices/{paymentHash}/verify',
  tags: ['Invoices'],
  summary: "Verify A Reader's Access Token",
  description:
    "Verifies that a reader's access token is valid for a specific article — for developers implementing " +
    'their own server-side content gate instead of using a Zap-hosted unlock endpoint.',
  security: [{ ApiKeyAuth: ['invoices:read'] }],
  middleware: [requireScope('invoices:read')] as const,
  request: {
    params: PaymentHashParamSchema,
    body: { content: { 'application/json': { schema: VerifyAccessTokenSchema } }, required: true },
  },
  responses: {
    200: { description: 'Verification result', content: { 'application/json': { schema: VerifyAccessTokenResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the invoices:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Payment hash not found', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure', content: { 'application/json': { schema: ValidationErrorSchema } } },
  },
})

invoices.openapi(verifyRoute, async (c) => {
  const { paymentHash } = c.req.valid('param')
  const { accessToken, articleId } = c.req.valid('json')
  const publisherId = c.get('publisherId')

  const invoice = await prisma.invoice.findUnique({
    where: { paymentHash },
    select: { article: { select: { publisherId: true } } },
  })
  if (!invoice || invoice.article.publisherId !== publisherId) {
    return errorResponse(c, 404, 'invoice_not_found', 'Payment hash not found.')
  }

  const result = await validateAccessTokenDetailed(accessToken, articleId)

  if (!result.valid) {
    return c.json({ valid: false as const, reason: result.reason }, 200)
  }

  return c.json({ valid: true as const, articleId: result.articleId, expiresAt: result.expiresAt.toISOString() }, 200)
})

// ─── GET /v1/invoices ────────────────────────────────────────────────────────────

const listInvoicesRoute = createRoute({
  method: 'get',
  path: '/invoices',
  tags: ['Invoices'],
  summary: 'List Invoices',
  description: 'Lists invoices for your published articles. Supports filtering by `articleId` and `status`.',
  security: [{ ApiKeyAuth: ['invoices:read'] }],
  middleware: [requireScope('invoices:read')] as const,
  request: { query: InvoiceListQuerySchema },
  responses: {
    200: { description: 'List of invoices', content: { 'application/json': { schema: InvoiceListResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the invoices:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

invoices.openapi(listInvoicesRoute, async (c) => {
  const { articleId, status, limit, offset } = c.req.valid('query')
  const publisherId = c.get('publisherId')

  const where = {
    article: { publisherId },
    ...(articleId ? { articleId } : {}),
    ...(status ? { status } : {}),
  }

  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        paymentHash: true,
        status: true,
        amountSats: true,
        articleId: true,
        createdAt: true,
        expiresAt: true,
        confirmedAt: true,
      },
    }),
    prisma.invoice.count({ where }),
  ])

  return c.json(
    {
      invoices: rows.map((inv) => ({
        paymentHash: inv.paymentHash,
        status: inv.status,
        amountSats: inv.amountSats,
        articleId: inv.articleId,
        createdAt: inv.createdAt.toISOString(),
        expiresAt: inv.expiresAt.toISOString(),
        confirmedAt: inv.confirmedAt ? inv.confirmedAt.toISOString() : null,
      })),
      total,
      limit,
      offset,
    },
    200,
  )
})

export default invoices
