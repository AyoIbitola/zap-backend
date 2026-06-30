import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { verifyPublisherJwt } from '../lib/jwt.js'
import type { AppEnv } from '../types/index.js'

export const publisherAuth = createMiddleware<AppEnv>(async (c, next) => {
  const cookieToken = getCookie(c, 'publisher_token')
  const headerToken = c.req.header('Authorization')?.replace('Bearer ', '')
  const token = cookieToken ?? headerToken

  if (!token) {
    return c.json({ error: 'unauthorized', message: 'Authentication required' }, 401)
  }

  try {
    const payload = await verifyPublisherJwt(token)
    c.set('publisher', payload)
    await next()
  } catch {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired token' }, 401)
  }
})
