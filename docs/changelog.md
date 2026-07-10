# Changelog

## 2026-07-10 — v1.0.0

Initial public release of the Zap API.

- **API keys** — secret and publishable keys, scoped access, prefix-based lookup, bcrypt-hashed storage
- **Articles** — full CRUD via `/v1/articles`, scoped to your publisher account, `fullBody` never exposed
- **Invoices** — generate Lightning invoices, poll status, verify reader access tokens
- **Webhooks** — register endpoints, HMAC-SHA256 signed deliveries, automatic retry with exponential backoff
- **Analytics** — revenue time series and per-article performance
- **Rate limiting** — Redis sliding-window limits per endpoint group, with `X-RateLimit-*` headers
- **Interactive docs** — OpenAPI 3.1 spec at `/api/openapi.json`, Scalar reference UI at `/docs`
