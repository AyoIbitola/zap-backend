import { createMiddleware } from 'hono/factory'
import { prisma } from '../../lib/prisma.js'
import { verifyApiKey } from '../../lib/apiKey.js'
import { errorResponse } from '../lib/errorResponse.js'
import type { V1Env } from '../types.js'

export const apiKeyAuth = createMiddleware<V1Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer zap_')) {
    return errorResponse(
      c,
      401,
      'unauthorized',
      'Missing or malformed Authorization header. Use "Authorization: Bearer zap_sk_..." (or zap_pk_... for read-only routes).',
    )
  }

  const raw = authHeader.slice(7) // remove "Bearer "
  const prefix = raw.slice(0, 16)

  const keyRecord = await prisma.apiKey.findFirst({
    where: { keyPrefix: prefix, revokedAt: null },
    select: { id: true, publisherId: true, keyHash: true, type: true, scopes: true },
  })

  if (!keyRecord) {
    return errorResponse(c, 401, 'invalid_api_key', 'API key not found. Check that you copied the full key correctly.')
  }

  const valid = await verifyApiKey(raw, keyRecord.keyHash)
  if (!valid) {
    return errorResponse(c, 401, 'invalid_api_key', 'API key verification failed.')
  }

  // Update lastUsedAt asynchronously — don't await, don't block the request
  prisma.apiKey.update({ where: { id: keyRecord.id }, data: { lastUsedAt: new Date() } }).catch(() => {})

  c.set('publisherId', keyRecord.publisherId)
  c.set('apiKeyId', keyRecord.id)
  c.set('keyType', keyRecord.type)
  c.set('keyScopes', keyRecord.scopes)
  c.set('keyPrefix', prefix)
  c.set('authMethod', 'apikey')

  await next()
})
