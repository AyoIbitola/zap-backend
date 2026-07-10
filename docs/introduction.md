# Introduction

## What is the Zap API

Zap is a Lightning Network pay-per-article paywall. The core product lets publishers write paywalled articles in the Zap dashboard and readers pay for them with Bitcoin Lightning. The **Zap API** turns that same system into a platform: any developer can generate Lightning invoices, gate content, and receive payment webhooks directly from their own code — no dependency on the Zap frontend.

The API and the hosted Zap product share the same data. An article you create via the API shows up in the publisher dashboard. A payment against an API-generated invoice counts toward the publisher's revenue stats. There is one system; the API is just another way in.

## Who it's for

- A developer embedding a Lightning paywall into their own site, blog, or app
- A developer building a tool on top of Zap (an analytics dashboard, a CMS plugin, an automation)

## The two things you can do with it

1. **Embed a Lightning paywall on your own site.** Generate invoices for your readers, verify their access tokens server-side, and gate your own content — without ever sending the reader to zap.pub.
2. **Build a tool on top of Zap.** Manage articles, pull revenue analytics, and react to payments in real time via webhooks.

## Quick links

- [Quickstart](./quickstart.md) — generate a key, create an article, take a payment, in under 15 minutes
- [Authentication](./authentication.md) — secret vs. publishable keys, scopes, how to send the header
- [API Reference](/docs) — the full interactive OpenAPI reference (Scalar), served by the API itself
- [Webhook events](./webhook-events.md) — event types, payload shapes, signature verification
- [Error codes](./error-codes.md) — every `error` string the API returns and how to handle it
