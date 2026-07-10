import { createMiddleware } from 'hono/factory'
import { errorResponse } from '../lib/errorResponse.js'
import type { Scope, V1Env } from '../types.js'

// A publisher authenticated via dashboard session (JWT) implicitly has every scope —
// scopes only restrict API keys, which are the thing being scoped in the first place.
export const requireScope = (scope: Scope) =>
  createMiddleware<V1Env>(async (c, next) => {
    if (c.get('authMethod') === 'publisher') {
      await next()
      return
    }

    const scopes = c.get('keyScopes') ?? []
    if (!scopes.includes(scope)) {
      return errorResponse(
        c,
        403,
        'insufficient_scope',
        `This action requires the '${scope}' scope. Generate a new key with this scope, or use one that already has it.`,
      )
    }

    await next()
  })
