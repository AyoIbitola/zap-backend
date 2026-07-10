# Error codes

Every error from `/v1/` uses the same shape:

```json
{
  "error": "machine_readable_code",
  "message": "Human-readable explanation of what went wrong and how to fix it.",
  "requestId": "uuid-for-support-reference"
}
```

Include the `requestId` when contacting support — it's logged server-side alongside the key prefix and endpoint that triggered it.

`422 validation_error` responses additionally include a `fields` object mapping each invalid field to a specific message:

```json
{
  "error": "validation_error",
  "message": "Request validation failed.",
  "requestId": "uuid",
  "fields": { "priceSats": "Must be a positive integer." }
}
```

## Full reference

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Request body or parameters are malformed or missing required fields |
| 400 | `article_not_published` | Article exists but is not published — publish it before generating invoices against it |
| 400 | `invalid_content_blocks` | `fullBody` isn't a valid `BlockNode[]` array |
| 400 | `cannot_revoke_active_key` | You tried to revoke the key currently authenticating the request |
| 401 | `unauthorized` | Missing or malformed `Authorization` header |
| 401 | `invalid_api_key` | Key not found, or verification failed — check you copied the full key |
| 403 | `insufficient_scope` | Your key lacks the scope this action requires — generate a key with that scope |
| 404 | `article_not_found` | Article doesn't exist, or belongs to another publisher |
| 404 | `invoice_not_found` | Payment hash not found |
| 404 | `endpoint_not_found` | Webhook endpoint not found |
| 404 | `key_not_found` | API key not found |
| 409 | `slug_conflict` | That article slug is already taken |
| 422 | `validation_error` | Field-level validation failure — see `fields` |
| 429 | `rate_limit_exceeded` | Too many requests — see `Retry-After` header and back off |
| 503 | `lightning_unavailable` | The Lightning node is unreachable — not your fault, retry shortly |

## Rate limit headers

Every rate-limited response includes:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1719755855
```

`X-RateLimit-Reset` is a Unix timestamp (seconds) for when the window rolls over. A `429` also includes `Retry-After` (seconds) — wait at least that long before retrying.
