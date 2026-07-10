import { z } from '@hono/zod-openapi'

// Rich text content model — mirrors the frontend's BlockNode/InlineNode types.
const InlineNodeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('bold'), text: z.string() }),
  z.object({ type: z.literal('italic'), text: z.string() }),
  z.object({ type: z.literal('link'), text: z.string(), href: z.string() }),
])

const BlockNodeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), children: z.array(InlineNodeSchema).min(1) }),
  z.object({ type: z.literal('heading2'), children: z.array(InlineNodeSchema).min(1) }),
  z.object({ type: z.literal('blockquote'), children: z.array(InlineNodeSchema).min(1) }),
  z.object({ type: z.literal('bulletList'), items: z.array(z.array(InlineNodeSchema).min(1)).min(1) }),
])

export const ContentBlocksSchema = z.array(BlockNodeSchema).min(1).openapi('ContentBlocks')

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, and hyphens only')

// Public shape returned by every article endpoint. fullBody is intentionally absent —
// it is never included in any /v1/articles response, per the non-negotiable PRD rule.
export const ArticleSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    slug: z.string(),
    subtitle: z.string().nullable(),
    teaserBody: z.string(),
    priceSats: z.number().int().positive(),
    topicTag: z.string().nullable(),
    published: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Article')

export const ArticleListResponseSchema = z
  .object({
    articles: z.array(ArticleSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('ArticleListResponse')

export const ArticleListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
  tag: z.string().optional(),
})

export const ArticleIdParamSchema = z.object({
  id: z.string().min(1).openapi({
    param: { name: 'id', in: 'path' },
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Article UUID or slug',
  }),
})

export const CreateArticleSchema = z
  .object({
    title: z.string().min(1),
    slug: slugSchema.optional().openapi({ description: 'Auto-generated from title if omitted.' }),
    subtitle: z.string().optional(),
    teaserBody: z.string().min(1),
    fullBody: ContentBlocksSchema.openapi({
      description: 'Full article content as a BlockNode[] array. Never returned by any endpoint.',
    }),
    priceSats: z.number().int().positive(),
    topicTag: z.string().optional(),
    published: z.boolean().optional().default(false),
  })
  .openapi('CreateArticleRequest')

export const UpdateArticleSchema = z
  .object({
    title: z.string().min(1).optional(),
    slug: slugSchema.optional(),
    subtitle: z.string().optional(),
    teaserBody: z.string().min(1).optional(),
    fullBody: ContentBlocksSchema.optional(),
    priceSats: z.number().int().positive().optional(),
    topicTag: z.string().optional(),
    published: z.boolean().optional(),
  })
  .openapi('UpdateArticleRequest')

export const DeleteArticleResponseSchema = z
  .object({ id: z.string().uuid(), published: z.literal(false) })
  .openapi('DeleteArticleResponse')
