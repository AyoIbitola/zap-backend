import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { prisma } from '../../lib/prisma.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'
import { requireScope } from '../middleware/requireScope.js'
import { rateLimitGroup } from '../middleware/rateLimit.js'
import { errorResponse } from '../lib/errorResponse.js'
import { zodErrorHook } from '../lib/validationHook.js'
import { slugify, slugWithSuffix } from '../lib/slugify.js'
import {
  ArticleSchema,
  ArticleListResponseSchema,
  ArticleListQuerySchema,
  ArticleIdParamSchema,
  CreateArticleSchema,
  UpdateArticleSchema,
  DeleteArticleResponseSchema,
} from '../schemas/article.schema.js'
import { ErrorSchema, ValidationErrorSchema } from '../schemas/error.schema.js'
import type { V1Env } from '../types.js'

const articles = new OpenAPIHono<V1Env>({ defaultHook: zodErrorHook })

articles.use(
  '*',
  rateLimitGroup([
    { name: 'articles-write', test: (c) => c.req.method === 'POST' && c.req.path === '/v1/articles', limit: 30, windowMs: 60_000 },
    { name: 'articles-read', test: (c) => c.req.method === 'GET' && c.req.path.startsWith('/v1/articles'), limit: 120, windowMs: 60_000 },
  ]),
)
articles.use('*', apiKeyAuth)

function serializeArticle(a: {
  id: string
  title: string
  slug: string
  subtitle: string | null
  teaserBody: string
  priceSats: number
  topicTag: string | null
  published: boolean
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    subtitle: a.subtitle,
    teaserBody: a.teaserBody,
    priceSats: a.priceSats,
    topicTag: a.topicTag,
    published: a.published,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

const ARTICLE_SELECT = {
  id: true,
  title: true,
  slug: true,
  subtitle: true,
  teaserBody: true,
  priceSats: true,
  topicTag: true,
  published: true,
  createdAt: true,
  updatedAt: true,
} as const

// ─── GET /v1/articles ──────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/articles',
  tags: ['Articles'],
  summary: 'List Published Articles',
  description:
    'Lists your published articles. Supports pagination via `limit`/`offset` and filtering by `tag`. ' +
    '`fullBody` is never included — use the internal unlock flow or `/v1/invoices/{hash}/verify` to gate content.',
  security: [{ ApiKeyAuth: ['articles:read'] }],
  middleware: [requireScope('articles:read')] as const,
  request: { query: ArticleListQuerySchema },
  responses: {
    200: { description: 'List of published articles', content: { 'application/json': { schema: ArticleListResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the articles:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

articles.openapi(listRoute, async (c) => {
  const { limit, offset, tag } = c.req.valid('query')
  const publisherId = c.get('publisherId')

  const where = { publisherId, published: true, ...(tag ? { topicTag: tag } : {}) }

  const [rows, total] = await Promise.all([
    prisma.article.findMany({ where, select: ARTICLE_SELECT, orderBy: { publishedAt: 'desc' }, take: limit, skip: offset }),
    prisma.article.count({ where }),
  ])

  return c.json({ articles: rows.map(serializeArticle), total, limit, offset }, 200)
})

// ─── GET /v1/articles/:id ──────────────────────────────────────────────────────

const getRoute = createRoute({
  method: 'get',
  path: '/articles/{id}',
  tags: ['Articles'],
  summary: 'Get An Article',
  description:
    'Fetches a single article by UUID or slug. Only articles owned by your publisher account are returned. ' +
    '`fullBody` is never included in this response.',
  security: [{ ApiKeyAuth: ['articles:read'] }],
  middleware: [requireScope('articles:read')] as const,
  request: { params: ArticleIdParamSchema },
  responses: {
    200: { description: 'The article', content: { 'application/json': { schema: ArticleSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the articles:read scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Article does not exist or belongs to another publisher', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

articles.openapi(getRoute, async (c) => {
  const { id } = c.req.valid('param')
  const publisherId = c.get('publisherId')

  const article = await prisma.article.findFirst({
    where: { publisherId, OR: [{ id }, { slug: id }] },
    select: ARTICLE_SELECT,
  })

  if (!article) {
    return errorResponse(c, 404, 'article_not_found', 'Article does not exist or belongs to another publisher.')
  }

  return c.json(serializeArticle(article), 200)
})

// ─── POST /v1/articles ─────────────────────────────────────────────────────────

const createArticleRoute = createRoute({
  method: 'post',
  path: '/articles',
  tags: ['Articles'],
  summary: 'Create An Article',
  description:
    'Creates a new paywalled article, visible immediately in the publisher dashboard. ' +
    '`fullBody` must be a BlockNode[] content array; if `slug` is omitted it is generated from `title`.',
  security: [{ ApiKeyAuth: ['articles:write'] }],
  middleware: [requireScope('articles:write')] as const,
  request: {
    body: { content: { 'application/json': { schema: CreateArticleSchema } }, required: true },
  },
  responses: {
    201: { description: 'Article created', content: { 'application/json': { schema: ArticleSchema } } },
    400: { description: 'fullBody content block array is malformed', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the articles:write scope', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Article slug already exists', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure', content: { 'application/json': { schema: ValidationErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

articles.openapi(createArticleRoute, async (c) => {
  const body = c.req.valid('json')
  const publisherId = c.get('publisherId')

  let slug = body.slug ?? slugify(body.title)

  let existing = await prisma.article.findUnique({ where: { slug } })
  if (existing && !body.slug) {
    // Auto-generated slug collided — retry once with a random suffix.
    slug = slugWithSuffix(body.title)
    existing = await prisma.article.findUnique({ where: { slug } })
  }
  if (existing) {
    return errorResponse(c, 409, 'slug_conflict', 'An article with this slug already exists.')
  }

  const created = await prisma.article.create({
    data: {
      publisherId,
      title: body.title,
      slug,
      subtitle: body.subtitle,
      teaserBody: body.teaserBody,
      fullBody: JSON.stringify(body.fullBody),
      priceSats: body.priceSats,
      topicTag: body.topicTag,
      published: body.published ?? false,
      publishedAt: body.published ? new Date() : undefined,
    },
    select: ARTICLE_SELECT,
  })

  return c.json(serializeArticle(created), 201)
})

// ─── PATCH /v1/articles/:id ─────────────────────────────────────────────────────

const updateArticleRoute = createRoute({
  method: 'patch',
  path: '/articles/{id}',
  tags: ['Articles'],
  summary: 'Update An Article',
  description: 'Partially updates an article you own. Any field except `id` can be changed.',
  security: [{ ApiKeyAuth: ['articles:write'] }],
  middleware: [requireScope('articles:write')] as const,
  request: {
    params: ArticleIdParamSchema,
    body: { content: { 'application/json': { schema: UpdateArticleSchema } }, required: true },
  },
  responses: {
    200: { description: 'Updated article', content: { 'application/json': { schema: ArticleSchema } } },
    400: { description: 'fullBody content block array is malformed', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the articles:write scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Article does not exist or belongs to another publisher', content: { 'application/json': { schema: ErrorSchema } } },
    409: { description: 'Article slug already exists', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure', content: { 'application/json': { schema: ValidationErrorSchema } } },
  },
})

articles.openapi(updateArticleRoute, async (c) => {
  const { id } = c.req.valid('param')
  const body = c.req.valid('json')
  const publisherId = c.get('publisherId')

  const existing = await prisma.article.findFirst({ where: { publisherId, OR: [{ id }, { slug: id }] } })
  if (!existing) {
    return errorResponse(c, 404, 'article_not_found', 'Article does not exist or belongs to another publisher.')
  }

  if (body.slug && body.slug !== existing.slug) {
    const slugConflict = await prisma.article.findUnique({ where: { slug: body.slug } })
    if (slugConflict) {
      return errorResponse(c, 409, 'slug_conflict', 'An article with this slug already exists.')
    }
  }

  const { fullBody, published, ...rest } = body
  const publishedAt = published === true && !existing.published ? new Date() : undefined

  const updated = await prisma.article.update({
    where: { id: existing.id },
    data: {
      ...rest,
      ...(fullBody ? { fullBody: JSON.stringify(fullBody) } : {}),
      ...(published !== undefined ? { published } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    },
    select: ARTICLE_SELECT,
  })

  return c.json(serializeArticle(updated), 200)
})

// ─── DELETE /v1/articles/:id ─────────────────────────────────────────────────────

const deleteArticleRoute = createRoute({
  method: 'delete',
  path: '/articles/{id}',
  tags: ['Articles'],
  summary: 'Unpublish An Article',
  description:
    'Unpublishes an article you own (sets `published: false`) and cancels any pending invoices for it. ' +
    'The article row is not deleted.',
  security: [{ ApiKeyAuth: ['articles:write'] }],
  middleware: [requireScope('articles:write')] as const,
  request: { params: ArticleIdParamSchema },
  responses: {
    200: { description: 'Article unpublished', content: { 'application/json': { schema: DeleteArticleResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the articles:write scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Article does not exist or belongs to another publisher', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

articles.openapi(deleteArticleRoute, async (c) => {
  const { id } = c.req.valid('param')
  const publisherId = c.get('publisherId')

  const existing = await prisma.article.findFirst({ where: { publisherId, OR: [{ id }, { slug: id }] } })
  if (!existing) {
    return errorResponse(c, 404, 'article_not_found', 'Article does not exist or belongs to another publisher.')
  }

  await prisma.$transaction([
    prisma.invoice.updateMany({ where: { articleId: existing.id, status: 'PENDING' }, data: { status: 'CANCELLED' } }),
    prisma.article.update({ where: { id: existing.id }, data: { published: false } }),
  ])

  return c.json({ id: existing.id, published: false as const }, 200)
})

export default articles
