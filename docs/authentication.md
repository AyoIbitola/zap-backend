# Authentication

Every `/v1/` request is authenticated with an API key sent as a bearer token:

```
Authorization: Bearer zap_sk_Ab3Xk9mQr7...
```

## Secret vs. publishable keys

**Secret key** (`zap_sk_...`)
Used for everything: creating articles, generating invoices, reading revenue, managing webhooks. Never expose it in browser JavaScript, mobile app bundles, or any client-side code — treat it like a database password. Server-to-server only.

**Publishable key** (`zap_pk_...`)
Safe to embed in browser JavaScript. Read-only, and scoped to exactly `articles:read` — it can fetch article title, price, and published status, and nothing else. It cannot create invoices, read revenue, or manage anything. Use it when you need article metadata (e.g. price, title) rendered directly in a frontend without a backend round-trip.

Both key types are 51 characters: a 7-character type prefix (`zap_sk_` or `zap_pk_`) followed by 44 base64url-encoded characters of entropy. The prefix makes key type unmistakable in logs and code review.

## Scopes

Secret keys carry one or more scopes. A key can only perform the actions its scopes allow:

| Scope | Permits |
|---|---|
| `articles:write` | Create, update, delete (unpublish) articles |
| `articles:read` | List and fetch article metadata |
| `invoices:create` | Generate Lightning invoices |
| `invoices:read` | Read invoice status, history, and verify access tokens |
| `analytics:read` | Read revenue and per-article stats |
| `webhooks:manage` | Register, update, delete, and test webhook endpoints |
| `keys:manage` | Generate and revoke API keys |

Create narrowly-scoped keys for narrow integrations — e.g. a key with only `invoices:create` for a checkout widget that should never be able to read your revenue data or delete your articles.

## Generating a key

```bash
curl -s -X POST https://api.zap.pub/v1/keys \
  -H "Authorization: Bearer <your dashboard session token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "SECRET",
    "label": "My blog integration",
    "scopes": ["articles:read", "invoices:create"]
  }'
```

- Omit `scopes` on a `SECRET` key to get every scope.
- `scopes` is ignored for `PUBLISHABLE` keys — they always get exactly `["articles:read"]`.
- The raw key appears **once**, in this response, under `key`. It is never shown again — not in the dashboard, not via any GET endpoint. Store it immediately (e.g. in a secrets manager or `.env` file that's gitignored).

Generating and revoking keys (`POST /v1/keys`, `DELETE /v1/keys/:id`, `GET /v1/keys`) is authenticated with your publisher dashboard session, not an API key — this avoids a chicken-and-egg problem for your very first key. You can alternatively call these endpoints with an existing secret key that has the `keys:manage` scope, useful for automating key rotation.

## Revoking a key

```bash
curl -s -X DELETE https://api.zap.pub/v1/keys/<key-id> \
  -H "Authorization: Bearer <your dashboard session token>"
```

Revocation is immediate — any request using that key returns `401 invalid_api_key` from that point on. You cannot revoke the key currently authenticating the request you're making (returns `400 cannot_revoke_active_key`), to stop you from locking yourself out.

## Security

- **Never** put a secret key in frontend code, a mobile app bundle, a public repo, or a URL query string.
- If a secret key leaks, revoke it immediately and generate a new one.
- Use publishable keys for anything that runs in a browser.
- Rate limits and scopes are enforced per key — see the [API Reference](/docs) for exact limits per endpoint.
