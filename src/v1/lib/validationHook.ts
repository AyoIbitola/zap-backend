import type { Context } from 'hono'
import type { ZodError } from 'zod'

type HookResult = { success: true } | { success: false; target: string; error: ZodError }

// Shared @hono/zod-openapi defaultHook — translates zod validation failures into the
// standard /v1/ error envelope. A malformed `fullBody` block array gets its own error
// code (invalid_content_blocks); everything else in the JSON body is validation_error;
// bad query/path params are invalid_request.
export function zodErrorHook(result: HookResult, c: Context) {
  if (result.success) return

  const fields: Record<string, string> = {}
  let hasFullBodyIssue = false
  for (const issue of result.error.issues) {
    const path = issue.path.join('.')
    fields[path || 'body'] = issue.message
    if (issue.path[0] === 'fullBody') hasFullBodyIssue = true
  }

  const requestId = c.get('requestId')

  if (result.target === 'json' && hasFullBodyIssue) {
    return c.json(
      { error: 'invalid_content_blocks', message: 'The fullBody content block array is malformed.', requestId, fields },
      400,
    )
  }

  if (result.target === 'json') {
    return c.json({ error: 'validation_error', message: 'Request validation failed.', requestId, fields }, 422)
  }

  return c.json({ error: 'invalid_request', message: 'Request parameters are invalid.', requestId, fields }, 400)
}
