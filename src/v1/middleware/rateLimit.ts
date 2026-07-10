import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getRedis } from '../../lib/redis.js'
import { errorResponse } from '../lib/errorResponse.js'
import type { V1Env } from '../types.js'

interface RateLimitRule {
  name: string
  test: (c: Context<V1Env>) => boolean
  limit: number
  windowMs: number
}

// Rate limiting must not wait on the (expensive, ~100ms) bcrypt comparison that
// apiKeyAuth performs — so this reads the key prefix straight off the raw
// Authorization header and must be mounted with `.use()` BEFORE `.use('*', apiKeyAuth)`
// in each router. The prefix is unverified but effectively unguessable (9 random
// base64url chars), so it's a safe bucketing key even before the secret is checked.
function extractKeyPrefix(c: Context<V1Env>): string | null {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer zap_')) return null
  return authHeader.slice(7, 23)
}

// Redis sliding-window counter (per Section 11): a ZSET per (rule, key prefix) holding
// one member per request timestamped by its arrival time. Entries older than the window
// are trimmed on each check, so the count always reflects a true rolling window rather
// than a fixed bucket that resets on a clock boundary.
export function rateLimitGroup(rules: RateLimitRule[]) {
  return createMiddleware<V1Env>(async (c, next) => {
    const rule = rules.find((r) => r.test(c))
    if (!rule) {
      await next()
      return
    }

    const prefix = extractKeyPrefix(c)
    if (!prefix) {
      // No plausible API key present — let apiKeyAuth (runs later) reject with 401.
      await next()
      return
    }

    const redis = getRedis()
    const redisKey = `v1rl:${rule.name}:${prefix}`
    const now = Date.now()
    const windowStart = now - rule.windowMs

    await redis.zremrangebyscore(redisKey, 0, windowStart)
    const count = await redis.zcard(redisKey)

    if (count >= rule.limit) {
      const oldest = await redis.zrange(redisKey, 0, 0, 'WITHSCORES')
      const oldestTs = oldest.length ? parseInt(oldest[1]!, 10) : now
      const resetAt = Math.ceil((oldestTs + rule.windowMs) / 1000)
      const retryAfterSec = Math.max(1, resetAt - Math.floor(now / 1000))

      c.header('X-RateLimit-Limit', String(rule.limit))
      c.header('X-RateLimit-Remaining', '0')
      c.header('X-RateLimit-Reset', String(resetAt))
      c.header('Retry-After', String(retryAfterSec))

      return errorResponse(
        c,
        429,
        'rate_limit_exceeded',
        `Too many requests. Retry after ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`,
        { retryAfter: retryAfterSec },
      )
    }

    await redis.zadd(redisKey, now, `${now}-${Math.random().toString(36).slice(2, 8)}`)
    await redis.pexpire(redisKey, rule.windowMs)

    const remaining = Math.max(0, rule.limit - count - 1)
    const resetAt = Math.ceil((now + rule.windowMs) / 1000)
    c.header('X-RateLimit-Limit', String(rule.limit))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset', String(resetAt))

    await next()
  })
}

// POST /v1/webhooks/:id/test is limited per endpoint (10/hour), not per key — a
// separate, narrower window keyed by the path param instead of the caller's identity.
export const webhookTestRateLimit = createMiddleware<V1Env>(async (c, next) => {
  const id = c.req.param('id')
  const redis = getRedis()
  const redisKey = `v1rl:webhook-test:${id}`
  const limit = 10
  const windowMs = 3_600_000
  const now = Date.now()

  await redis.zremrangebyscore(redisKey, 0, now - windowMs)
  const count = await redis.zcard(redisKey)

  if (count >= limit) {
    const oldest = await redis.zrange(redisKey, 0, 0, 'WITHSCORES')
    const oldestTs = oldest.length ? parseInt(oldest[1]!, 10) : now
    const resetAt = Math.ceil((oldestTs + windowMs) / 1000)
    const retryAfterSec = Math.max(1, resetAt - Math.floor(now / 1000))

    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', '0')
    c.header('X-RateLimit-Reset', String(resetAt))
    c.header('Retry-After', String(retryAfterSec))

    return errorResponse(
      c,
      429,
      'rate_limit_exceeded',
      `Too many test events for this endpoint. Retry after ${retryAfterSec} seconds.`,
      { retryAfter: retryAfterSec },
    )
  }

  await redis.zadd(redisKey, now, `${now}-${Math.random().toString(36).slice(2, 8)}`)
  await redis.pexpire(redisKey, windowMs)

  const remaining = Math.max(0, limit - count - 1)
  const resetAt = Math.ceil((now + windowMs) / 1000)
  c.header('X-RateLimit-Limit', String(limit))
  c.header('X-RateLimit-Remaining', String(remaining))
  c.header('X-RateLimit-Reset', String(resetAt))

  await next()
})
