import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { verifyPublisherJwt } from '../../lib/jwt.js'
import { prisma } from '../../lib/prisma.js'
import { verifyApiKey } from '../../lib/apiKey.js'
import { errorResponse } from '../lib/errorResponse.js'
import type { V1Env } from '../types.js'

// Key management bootstraps itself: the very first key can't be created by presenting
// a key. Accept either the publisher's dashboard session (JWT, cookie or bearer) or an
// existing secret key with the keys:manage scope (checked separately via requireScope).
export const keysAuth = createMiddleware<V1Env>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined

  if (bearer?.startsWith('zap_sk_') || bearer?.startsWith('zap_pk_')) {
    const prefix = bearer.slice(0, 16)
    const keyRecord = await prisma.apiKey.findFirst({
      where: { keyPrefix: prefix, revokedAt: null },
      select: { id: true, publisherId: true, keyHash: true, type: true, scopes: true },
    })

    if (!keyRecord || !(await verifyApiKey(bearer, keyRecord.keyHash))) {
      return errorResponse(c, 401, 'invalid_api_key', 'API key not found or verification failed.')
    }

    prisma.apiKey.update({ where: { id: keyRecord.id }, data: { lastUsedAt: new Date() } }).catch(() => {})

    c.set('publisherId', keyRecord.publisherId)
    c.set('apiKeyId', keyRecord.id)
    c.set('keyType', keyRecord.type)
    c.set('keyScopes', keyRecord.scopes)
    c.set('keyPrefix', prefix)
    c.set('authMethod', 'apikey')
    await next()
    return
  }

  const cookieToken = getCookie(c, 'publisher_token')
  const token = cookieToken ?? bearer

  if (!token) {
    return errorResponse(
      c,
      401,
      'unauthorized',
      'Sign in to the Zap dashboard, or provide a secret key with the keys:manage scope.',
    )
  }

  try {
    const payload = await verifyPublisherJwt(token)
    c.set('publisherId', payload.publisherId)
    c.set('authMethod', 'publisher')
    await next()
  } catch {
    return errorResponse(c, 401, 'unauthorized', 'Invalid or expired session.')
  }
})
