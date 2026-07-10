# Guides

## Embedding a Lightning paywall in a Next.js site

The core loop is: create the invoice on your server (never expose your secret key to the browser), render the QR code client-side, and poll or listen for the webhook to unlock content.

```typescript
// app/api/create-invoice/route.ts — your Next.js API route, holds the secret key
export async function POST(req: Request) {
  const { articleId, readerFingerprint } = await req.json()

  const res = await fetch('https://api.zap.pub/v1/invoices', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZAP_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ articleId, readerFingerprint }),
  })

  return Response.json(await res.json())
}
```

```typescript
// components/PaywallModal.tsx — client component, never sees the secret key
'use client'
import { useEffect, useState } from 'react'

export function PaywallModal({ articleId }: { articleId: string }) {
  const [invoice, setInvoice] = useState<{ paymentHash: string; invoiceString: string } | null>(null)
  const [unlocked, setUnlocked] = useState(false)

  useEffect(() => {
    fetch('/api/create-invoice', {
      method: 'POST',
      body: JSON.stringify({ articleId, readerFingerprint: crypto.randomUUID() }),
    })
      .then((r) => r.json())
      .then(setInvoice)
  }, [articleId])

  useEffect(() => {
    if (!invoice) return
    const interval = setInterval(async () => {
      const res = await fetch(`/api/invoice-status?paymentHash=${invoice.paymentHash}`)
      const data = await res.json()
      if (data.status === 'PAID') {
        setUnlocked(true)
        clearInterval(interval)
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [invoice])

  if (unlocked) return null // content is now visible
  if (!invoice) return <p>Loading invoice…</p>
  return <QRCode value={invoice.invoiceString} /> // any QR library
}
```

Add a matching `app/api/invoice-status/route.ts` that proxies `GET /v1/invoices/:paymentHash` the same way `create-invoice` proxies the POST. Keeping the secret key server-side the whole time is the point — the browser only ever talks to your own Next.js routes.

## Embedding a Lightning paywall in WordPress

*Coming soon.* In the meantime, the [Quickstart](./quickstart.md) cURL examples work unmodified from any PHP backend (`wp_remote_post`), since the API is plain HTTPS + JSON.

## Verifying webhook signatures

Every outbound delivery includes three headers: `Zap-Webhook-Id`, `Zap-Webhook-Timestamp`, and `Zap-Webhook-Signature`. Recompute the signature with your endpoint's secret and compare — do not trust a webhook body without doing this.

```typescript
// Verifying a Zap webhook in your server
import crypto from 'crypto'

function verifyWebhook(
  secret: string,
  headers: {
    'zap-webhook-id': string
    'zap-webhook-timestamp': string
    'zap-webhook-signature': string
  },
  rawBody: string
): boolean {
  const timestamp = parseInt(headers['zap-webhook-timestamp'])
  const now = Math.floor(Date.now() / 1000)

  // Reject events older than 5 minutes
  if (Math.abs(now - timestamp) > 300) return false

  const toSign = `${headers['zap-webhook-id']}.${timestamp}.${rawBody}`
  const expected = crypto
    .createHmac('sha256', secret)
    .update(toSign)
    .digest('hex')

  const received = headers['zap-webhook-signature'].replace('v1=', '')

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  )
}
```

**`rawBody` must be the exact string bytes that were sent** — not a JSON.stringify of the parsed object, which can reorder keys or change whitespace and break the signature. Read the raw request body before your framework parses it (e.g. `express.raw()` middleware, or Next.js's `req.text()`).

Test your implementation against a real delivery with `POST /v1/webhooks/:id/test` — see [Webhook events](./webhook-events.md#testing-your-endpoint).

## Handling expired invoices

Invoices expire after their `expiresAt` timestamp (roughly 15–60 minutes depending on configuration) if unpaid. Polling `GET /v1/invoices/:paymentHash` returns `status: "EXPIRED"`, and if you registered a webhook for `invoice.expired`, you'll get a push notification instead of needing to poll to the end.

When you see `EXPIRED`, stop polling and prompt the reader to generate a fresh invoice — `POST /v1/invoices` again with the same `articleId`. There's no separate "renew" endpoint; a new invoice is just a new invoice. Zap automatically dedupes rapid repeat requests from the same `readerFingerprint` within a short window, so retrying on expiry is safe and won't spam your reader with redundant invoices.

## Building a per-article analytics dashboard

`GET /v1/analytics/articles` returns revenue, paid-invoice count, and conversion rate per article in one call — enough for a simple table. Pair it with `GET /v1/analytics/revenue?period=30d&granularity=day` for a time-series chart of total revenue.

```bash
curl -s "https://api.zap.pub/v1/analytics/articles?sort=revenue&limit=10" \
  -H "Authorization: Bearer zap_sk_your_key_here"
```

```json
{
  "articles": [
    { "id": "uuid", "title": "Why Lightning changes everything", "priceSats": 50, "totalRevenueSats": 7100, "totalPaidInvoices": 142, "conversionRate": 0.34 }
  ]
}
```

`conversionRate` is paid invoices divided by total invoices generated (paid, expired, or still pending) — a rough proxy for how compelling your teaser/price combination is for that article. Both endpoints require the `analytics:read` scope and are rate-limited to 30 requests/minute.
