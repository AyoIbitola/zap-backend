import { Hono } from 'hono'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { publisherAuth } from '../middleware/auth.js'
import { internalSecret } from '../middleware/internalSecret.js'
import { validateAccessToken } from '../services/accessToken.service.js'
import type { AppEnv } from '../types/index.js'

const articles = new Hono<AppEnv>()

const PUBLIC_SELECT = {
  id: true,
  title: true,
  slug: true,
  subtitle: true,
  teaserBody: true,
  priceSats: true,
  topicTag: true,
  featured: true,
  published: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  publisher: {
    select: { id: true, displayName: true, bio: true },
  },
} as const

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens only')

const createArticleSchema = z.object({
  title: z.string().min(1),
  slug: slugSchema,
  subtitle: z.string().optional(),
  teaserBody: z.string().min(1),
  fullBody: z.string().min(1),
  priceSats: z.number().int().min(1),
  topicTag: z.string().optional(),
  featured: z.boolean().optional(),
  published: z.boolean().optional(),
})

const updateArticleSchema = z
  .object({
    title: z.string().min(1).optional(),
    slug: slugSchema.optional(),
    subtitle: z.string().optional(),
    teaserBody: z.string().min(1).optional(),
    fullBody: z.string().min(1).optional(),
    priceSats: z.number().int().min(1).optional(),
    topicTag: z.string().optional(),
    featured: z.boolean().optional(),
    published: z.boolean().optional(),
  })
  .strict()

// POST /api/articles — create article (publisher auth)
articles.post('/', publisherAuth, async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const result = createArticleSchema.safeParse(body)
  if (!result.success) {
    return c.json(
      { error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' },
      422,
    )
  }

  const { publisherId } = c.get('publisher')
  const { title, slug, subtitle, teaserBody, fullBody, priceSats, topicTag, featured, published } = result.data

  const existing = await prisma.article.findUnique({ where: { slug } })
  if (existing) {
    return c.json({ error: 'slug_taken', message: 'An article with this slug already exists' }, 409)
  }

  const publishedAt = published ? new Date() : undefined

  const article = await prisma.article.create({
    data: {
      publisherId,
      title,
      slug,
      subtitle,
      teaserBody,
      fullBody,
      priceSats,
      topicTag,
      featured: featured ?? false,
      published: published ?? false,
      publishedAt,
    },
    select: PUBLIC_SELECT,
  })

  return c.json(article, 201)
})

// GET /api/articles — list published articles (public)
articles.get('/', async (c) => {
  const search = c.req.query('search')
  const tag = c.req.query('tag')
  const featuredOnly = c.req.query('featured') === 'true'
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100)

  const where: Record<string, unknown> = { published: true }
  if (tag) where.topicTag = tag
  if (featuredOnly) where.featured = true
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { teaserBody: { contains: search, mode: 'insensitive' } },
      { publisher: { displayName: { contains: search, mode: 'insensitive' } } },
    ]
  }

  const list = await prisma.article.findMany({
    where,
    select: PUBLIC_SELECT,
    orderBy: { publishedAt: 'desc' },
    take: limit,
  })

  return c.json(list)
})

// GET /api/articles/:slug — single published article (public)
articles.get('/:slug', async (c) => {
  const slug = c.req.param('slug')

  const article = await prisma.article.findFirst({
    where: { slug, published: true },
    select: PUBLIC_SELECT,
  })

  if (!article) {
    return c.json({ error: 'not_found', message: 'Article not found' }, 404)
  }

  return c.json(article)
})

// PATCH /api/articles/:id — partial update (publisher auth, must own)
articles.patch('/:id', publisherAuth, async (c) => {
  const id = c.req.param('id')
  const { publisherId } = c.get('publisher')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const result = updateArticleSchema.safeParse(body)
  if (!result.success) {
    return c.json(
      { error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' },
      422,
    )
  }

  const existing = await prisma.article.findUnique({ where: { id } })
  if (!existing) {
    return c.json({ error: 'not_found', message: 'Article not found' }, 404)
  }
  if (existing.publisherId !== publisherId) {
    return c.json({ error: 'forbidden', message: 'You do not own this article' }, 403)
  }

  // Check slug uniqueness if changing slug
  if (result.data.slug && result.data.slug !== existing.slug) {
    const slugConflict = await prisma.article.findUnique({ where: { slug: result.data.slug } })
    if (slugConflict) {
      return c.json({ error: 'slug_taken', message: 'An article with this slug already exists' }, 409)
    }
  }

  const { published, ...rest } = result.data

  const publishedAt =
    published === true && !existing.published ? new Date() : undefined

  const updated = await prisma.article.update({
    where: { id },
    data: { ...rest, ...(published !== undefined ? { published } : {}), ...(publishedAt ? { publishedAt } : {}) },
    select: PUBLIC_SELECT,
  })

  return c.json(updated)
})

// DELETE /api/articles/:id — soft delete (publisher auth, must own)
articles.delete('/:id', publisherAuth, async (c) => {
  const id = c.req.param('id')
  const { publisherId } = c.get('publisher')

  const existing = await prisma.article.findUnique({ where: { id } })
  if (!existing) {
    return c.json({ error: 'not_found', message: 'Article not found' }, 404)
  }
  if (existing.publisherId !== publisherId) {
    return c.json({ error: 'forbidden', message: 'You do not own this article' }, 403)
  }

  await prisma.$transaction([
    prisma.invoice.updateMany({
      where: { articleId: id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    }),
    prisma.article.update({
      where: { id },
      data: { published: false },
    }),
  ])

  return c.json({ success: true })
})

// POST /api/articles/:slug/unlock — server-to-server content delivery
articles.post('/:slug/unlock', internalSecret, async (c) => {
  const slug = c.req.param('slug')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_request', message: 'Request body must be valid JSON' }, 400)
  }

  const parsed = z.object({ accessToken: z.string().min(1) }).safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', message: 'accessToken is required' }, 400)
  }

  const article = await prisma.article.findUnique({
    where: { slug },
    select: { id: true, fullBody: true },
  })
  if (!article) {
    return c.json({ error: 'not_found', message: 'Article not found' }, 404)
  }

  const validation = await validateAccessToken(parsed.data.accessToken, article.id)
  if (!validation.valid) {
    return c.json({ error: 'unauthorized', message: validation.reason }, 401)
  }

  return c.json({ fullBody: article.fullBody, articleId: article.id })
})

export default articles
