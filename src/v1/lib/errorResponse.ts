import type { Context } from 'hono'

export function errorResponse<S extends 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503>(
  c: Context,
  status: S,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return c.json({ error, message, requestId: c.get('requestId'), ...extra }, status)
}
