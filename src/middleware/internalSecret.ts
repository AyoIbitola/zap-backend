import { createMiddleware } from 'hono/factory'
import { createHash, timingSafeEqual } from 'node:crypto'

export const internalSecret = createMiddleware(async (c, next) => {
  const provided = c.req.header('X-Internal-Secret') ?? ''
  const expected = process.env.INTERNAL_API_SECRET!

  // Hash both values to fixed-length buffers before comparing (prevents length leakage)
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(expected).digest()

  if (!timingSafeEqual(providedHash, expectedHash)) {
    return c.json({ error: 'forbidden', message: 'Missing or invalid X-Internal-Secret' }, 403)
  }

  await next()
})
