import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { prisma } from '../../lib/prisma.js'
import { generateApiKey } from '../../lib/apiKey.js'
import { keysAuth } from '../middleware/keysAuth.js'
import { requireScope } from '../middleware/requireScope.js'
import { rateLimitGroup } from '../middleware/rateLimit.js'
import { errorResponse } from '../lib/errorResponse.js'
import { zodErrorHook } from '../lib/validationHook.js'
import {
  KeyListResponseSchema,
  CreateKeySchema,
  CreateKeyResponseSchema,
  KeyIdParamSchema,
  RevokeKeyResponseSchema,
} from '../schemas/key.schema.js'
import { ErrorSchema, ValidationErrorSchema } from '../schemas/error.schema.js'
import { ALL_SCOPES } from '../types.js'
import type { V1Env } from '../types.js'

const keys = new OpenAPIHono<V1Env>({ defaultHook: zodErrorHook })

keys.use(
  '*',
  rateLimitGroup([
    { name: 'keys-create', test: (c) => c.req.method === 'POST' && c.req.path === '/v1/keys', limit: 10, windowMs: 3_600_000 },
    { name: 'keys-delete', test: (c) => c.req.method === 'DELETE' && c.req.path.startsWith('/v1/keys/'), limit: 10, windowMs: 3_600_000 },
  ]),
)
keys.use('*', keysAuth)

// ─── GET /v1/keys ────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/keys',
  tags: ['Keys'],
  summary: 'List API Keys',
  description:
    'Lists all non-revoked API keys for your publisher account. Never returns the raw key or its hash — ' +
    'only the stored 16-character prefix. Authenticate with your dashboard session, or a secret key with the keys:manage scope.',
  security: [{ ApiKeyAuth: ['keys:manage'] }],
  middleware: [requireScope('keys:manage')] as const,
  responses: {
    200: { description: 'List of keys', content: { 'application/json': { schema: KeyListResponseSchema } } },
    401: { description: 'Missing or invalid credentials', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the keys:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

keys.openapi(listRoute, async (c) => {
  const publisherId = c.get('publisherId')

  const rows = await prisma.apiKey.findMany({
    where: { publisherId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, type: true, keyPrefix: true, label: true, scopes: true, lastUsedAt: true, createdAt: true },
  })

  return c.json(
    {
      keys: rows.map((k) => ({
        id: k.id,
        type: k.type,
        prefix: k.keyPrefix,
        label: k.label,
        scopes: k.scopes as (typeof ALL_SCOPES)[number][],
        lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
        createdAt: k.createdAt.toISOString(),
      })),
    },
    200,
  )
})

// ─── POST /v1/keys ───────────────────────────────────────────────────────────────

const createRouteDef = createRoute({
  method: 'post',
  path: '/keys',
  tags: ['Keys'],
  summary: 'Generate An API Key',
  description:
    'Generates a new secret or publishable key. The raw key is returned exactly once in this response — ' +
    'store it immediately, it cannot be retrieved again. Publishable keys always get exactly the articles:read scope.',
  security: [{ ApiKeyAuth: ['keys:manage'] }],
  middleware: [requireScope('keys:manage')] as const,
  request: { body: { content: { 'application/json': { schema: CreateKeySchema } }, required: true } },
  responses: {
    201: { description: 'Key created — raw value shown once', content: { 'application/json': { schema: CreateKeyResponseSchema } } },
    401: { description: 'Missing or invalid credentials', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the keys:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure', content: { 'application/json': { schema: ValidationErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

keys.openapi(createRouteDef, async (c) => {
  const { type, label, scopes: requestedScopes } = c.req.valid('json')
  const publisherId = c.get('publisherId')

  const scopes = type === 'PUBLISHABLE' ? ['articles:read'] : (requestedScopes ?? [...ALL_SCOPES])

  const generated = await generateApiKey(type)

  const created = await prisma.apiKey.create({
    data: { publisherId, keyHash: generated.hash, keyPrefix: generated.prefix, type: generated.type, scopes, label },
    select: { id: true, type: true, keyPrefix: true, label: true, scopes: true, createdAt: true },
  })

  return c.json(
    {
      id: created.id,
      type: created.type,
      key: generated.raw,
      prefix: created.keyPrefix,
      label: created.label,
      scopes: created.scopes as (typeof ALL_SCOPES)[number][],
      createdAt: created.createdAt.toISOString(),
      warning: 'Store this key now. It will not be shown again.',
    },
    201,
  )
})

// ─── DELETE /v1/keys/:id ───────────────────────────────────────────────────────────

const deleteRoute = createRoute({
  method: 'delete',
  path: '/keys/{id}',
  tags: ['Keys'],
  summary: 'Revoke An API Key',
  description:
    'Revokes a key immediately — subsequent requests using it return 401. You cannot revoke the key ' +
    'currently authenticating the request (to prevent locking yourself out).',
  security: [{ ApiKeyAuth: ['keys:manage'] }],
  middleware: [requireScope('keys:manage')] as const,
  request: { params: KeyIdParamSchema },
  responses: {
    200: { description: 'Key revoked', content: { 'application/json': { schema: RevokeKeyResponseSchema } } },
    400: { description: 'Attempted to revoke the key in use', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Missing or invalid credentials', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the keys:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Key not found', content: { 'application/json': { schema: ErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

keys.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid('param')
  const publisherId = c.get('publisherId')

  if (c.get('authMethod') === 'apikey' && c.get('apiKeyId') === id) {
    return errorResponse(c, 400, 'cannot_revoke_active_key', 'You cannot revoke the key currently used to authenticate this request.')
  }

  const existing = await prisma.apiKey.findFirst({ where: { id, publisherId, revokedAt: null } })
  if (!existing) {
    return errorResponse(c, 404, 'key_not_found', 'API key not found.')
  }

  const revoked = await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() }, select: { id: true, revokedAt: true } })

  return c.json({ id: revoked.id, revokedAt: revoked.revokedAt!.toISOString() }, 200)
})

export default keys
