import { z } from '@hono/zod-openapi'
import { ALL_SCOPES } from '../types.js'

export const ScopeSchema = z.enum(ALL_SCOPES)

export const KeySchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(['SECRET', 'PUBLISHABLE']),
    prefix: z.string(),
    label: z.string().nullable(),
    scopes: z.array(ScopeSchema),
    lastUsedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('ApiKey')

export const KeyListResponseSchema = z.object({ keys: z.array(KeySchema) }).openapi('ApiKeyListResponse')

export const CreateKeySchema = z
  .object({
    type: z.enum(['SECRET', 'PUBLISHABLE']),
    label: z.string().max(100).optional(),
    scopes: z.array(ScopeSchema).optional().openapi({
      description: 'Ignored for PUBLISHABLE keys (always articles:read). Defaults to all scopes for SECRET keys.',
    }),
  })
  .openapi('CreateApiKeyRequest')

export const CreateKeyResponseSchema = KeySchema.omit({ lastUsedAt: true })
  .extend({
    key: z.string().openapi({ description: 'Raw key — shown once, never again.', example: 'zap_sk_Ab3Xk9mQr7...' }),
    warning: z.string(),
  })
  .openapi('CreateApiKeyResponse')

export const KeyIdParamSchema = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
})

export const RevokeKeyResponseSchema = z
  .object({ id: z.string().uuid(), revokedAt: z.string().datetime() })
  .openapi('RevokeApiKeyResponse')
