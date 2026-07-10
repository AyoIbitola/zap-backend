# Webhook events

Zap can push payment events to your server in real time instead of you polling `GET /v1/invoices/:paymentHash`. Register an endpoint with `POST /v1/webhooks` (see the [API Reference](/docs)) and Zap will POST to it as events happen.

## Event types

| Event | Triggered when |
|---|---|
| `invoice.paid` | A reader successfully pays an invoice |
| `invoice.expired` | An invoice's window closes unpaid |
| `invoice.cancelled` | A publisher unpublishes an article with pending invoices |
| `webhook.test` | You call `POST /v1/webhooks/:id/test` |

## Payload shape

Every delivery has this envelope:

```json
{
  "id": "evt_uuid",
  "event": "invoice.paid",
  "createdAt": "2026-06-30T14:23:15Z",
  "data": {
    "paymentHash": "abc123def456...",
    "articleId": "uuid",
    "articleTitle": "Why Lightning changes everything",
    "amountSats": 50,
    "readerFingerprint": "developer-provided-fingerprint",
    "accessToken": "eyJ...",
    "paidAt": "2026-06-30T14:23:15Z"
  }
}
```

`invoice.expired` payloads omit `articleTitle` and `accessToken` and add `expiredAt` in place of `paidAt`.

## Signature verification

Every delivery carries three headers:

```
Zap-Webhook-Id: evt_uuid
Zap-Webhook-Timestamp: 1719755795
Zap-Webhook-Signature: v1=<hex-encoded-HMAC-SHA256>
```

The signature is `HMAC-SHA256(key = your endpoint's secret, input = "{evt_id}.{timestamp}.{rawBodyString}")` — the same scheme used by Stripe and Svix. See [Guides → Verifying webhook signatures](./guides.md#verifying-webhook-signatures) for the full, tested verification code. Always reject events with a timestamp more than 5 minutes old, to prevent replay attacks.

## Retry behavior and failure handling

If your endpoint doesn't respond with a `2xx` status (or times out after 10 seconds), Zap retries with exponential backoff, up to 5 attempts total. Every attempt — success or failure — is recorded and visible to you: response status, response body (first 1000 characters), and duration. After the final attempt fails, the delivery is marked permanently failed; there is no further automatic retry.

A slow or failing endpoint never affects payment confirmation itself — invoice status updates and access tokens are issued regardless of whether your webhook delivery succeeds.

## Testing your endpoint

```bash
curl -s -X POST https://api.zap.pub/v1/webhooks/<endpoint-id>/test \
  -H "Authorization: Bearer zap_sk_your_key_here"
```

This sends a synthetic `webhook.test` event synchronously and returns the response your server sent back:

```json
{ "delivered": true, "responseStatus": 200, "responseBody": "{\"received\": true}", "durationMs": 143 }
```

Use it to confirm your endpoint is reachable and that your signature verification code accepts a real, correctly-signed delivery before going live. This endpoint is rate-limited to 10 requests/hour per endpoint.
