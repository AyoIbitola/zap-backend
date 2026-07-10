# Quickstart

This is the fastest path from zero to a working paywall: get a key, create an article, take a payment, and detect it. Every command below is copy-pasteable and has been run against a live Zap instance. Replace `https://api.zap.pub` with your own deployment's base URL if you're self-hosting.

## 1. Get your API key

Every publisher already has an account (sign up at the Zap dashboard, or via `POST /api/auth/register`). Sign in to get a session token, then use it once to mint a secret API key — after this step you never need the session token again.

```bash
# Sign in (or register) to get a session token
curl -s -X POST https://api.zap.pub/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "your-password"}'
# -> { "accessToken": "eyJ...", "expiresIn": 86400 }

# Use the session token once to create a secret API key
curl -s -X POST https://api.zap.pub/v1/keys \
  -H "Authorization: Bearer eyJ...your-session-token" \
  -H "Content-Type: application/json" \
  -d '{"type": "SECRET", "label": "Quickstart"}'
```

Response:

```json
{
  "id": "uuid",
  "type": "SECRET",
  "key": "zap_sk_Ab3Xk9mQr7...",
  "prefix": "zap_sk_Ab3Xk9mQ",
  "scopes": ["articles:write", "articles:read", "invoices:create", "invoices:read", "analytics:read", "webhooks:manage", "keys:manage"],
  "createdAt": "2026-06-30T14:22:00Z",
  "warning": "Store this key now. It will not be shown again."
}
```

**Copy the `key` value now** — `zap_sk_Ab3Xk9mQr7...` in this example. It is never shown again. From here on, every request uses `Authorization: Bearer <your key>`.

## 2. Create an article

```bash
curl -s -X POST https://api.zap.pub/v1/articles \
  -H "Authorization: Bearer zap_sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Why Lightning changes everything",
    "teaserBody": "For the last decade, media companies have chased subscriptions.",
    "fullBody": [
      { "type": "paragraph", "children": [{ "type": "text", "text": "Full article content goes here." }] }
    ],
    "priceSats": 50,
    "published": true
  }'
```

`slug` is auto-generated from `title` if you omit it. `fullBody` is a `BlockNode[]` array — see the [API Reference](/docs) for the full content model. Note that `fullBody` is never returned by any `GET` — that's intentional, see [Authentication](./authentication.md).

Response (`201`):

```json
{
  "id": "uuid",
  "title": "Why Lightning changes everything",
  "slug": "why-lightning-changes-everything",
  "priceSats": 50,
  "published": true,
  "createdAt": "2026-06-30T14:22:00Z",
  "updatedAt": "2026-06-30T14:22:00Z"
}
```

Save the `id` — you'll need it to generate an invoice.

## 3. Generate an invoice

```bash
curl -s -X POST https://api.zap.pub/v1/invoices \
  -H "Authorization: Bearer zap_sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "articleId": "the-article-id-from-step-2",
    "readerFingerprint": "reader-session-hash"
  }'
```

`readerFingerprint` is an opaque string you provide to identify the reader's session — used only for dedup, never treated as an identity. Hash any PII before sending it (e.g. `SHA256(userId + articleId)`). If you omit it, Zap generates a random one.

Response (`201`):

```json
{
  "paymentHash": "abc123def456...",
  "invoiceString": "lnbc500n1pjx8v2cpp5...",
  "amountSats": 50,
  "expiresAt": "2026-06-30T14:37:00Z",
  "status": "PENDING"
}
```

Render `invoiceString` as a QR code for the reader to scan, or hand it to a Lightning wallet browser extension.

## 4. Detect payment

Poll every 2 seconds, or [register a webhook](./webhook-events.md) to be notified instantly instead.

```bash
curl -s https://api.zap.pub/v1/invoices/abc123def456... \
  -H "Authorization: Bearer zap_sk_your_key_here"
```

While pending:

```json
{ "paymentHash": "abc123...", "status": "PENDING", "amountSats": 50, "articleId": "uuid", "createdAt": "...", "expiresAt": "...", "confirmedAt": null }
```

Once paid:

```json
{ "paymentHash": "abc123...", "status": "PAID", "confirmedAt": "2026-06-30T14:23:15Z", "accessToken": "eyJ..." }
```

`accessToken` is only present for 60 seconds after confirmation — grab it and store it (or the `invoice.paid` webhook payload) immediately.

## 5. Unlock content

You now have an `accessToken` scoped to this reader and this article. Verify it server-side whenever the reader wants to view the full content:

```bash
curl -s -X POST https://api.zap.pub/v1/invoices/abc123def456.../verify \
  -H "Authorization: Bearer zap_sk_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "accessToken": "eyJ...",
    "articleId": "the-article-id-from-step-2"
  }'
```

```json
{ "valid": true, "articleId": "uuid", "expiresAt": "2026-07-01T14:23:15Z" }
```

If `valid` is `true`, serve your reader the full article content (which you already have — you wrote it in step 2). That's the whole flow: key → article → invoice → payment → verified access.

**Next:** [Verify webhook signatures](./guides.md#verifying-webhook-signatures) so you don't have to poll, or browse the full [API Reference](/docs).
