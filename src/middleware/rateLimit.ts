import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getRedis } from '../lib/redis.js'

function getClientIP(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  )
}

/**
 * Redis fixed-window rate limiter middleware.
 * keyFn defaults to client IP when not provided.
 */
export function rateLimit(opts: {
  limit: number
  windowMs: number
  keyFn?: (c: Context) => string
}) {
  const keyFn = opts.keyFn ?? getClientIP

  return createMiddleware(async (c, next) => {
    const result = await checkRateLimit(keyFn(c), opts.limit, opts.windowMs)
    if (!result.allowed) {
      c.header('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString())
      return c.json({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, 429)
    }
    await next()
  })
}

/**
 * Standalone rate limit check — call from route handlers when the key is
 * only available after body parsing (e.g. reader fingerprint).
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const redis = getRedis()
  const redisKey = `rl:${key}`

  const count = await redis.incr(redisKey)
  if (count === 1) {
    await redis.pexpire(redisKey, windowMs)
  }

  if (count > limit) {
    const ttl = await redis.pttl(redisKey)
    return { allowed: false, retryAfterMs: Math.max(ttl, 0) }
  }

  return { allowed: true, retryAfterMs: 0 }
}
