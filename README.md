# Zap Backend — Lightning Pay-per-Article Paywall

## Overview

Three processes run together:

| Process | Entry point | Role |
|---|---|---|
| API server | `src/index.ts` | HTTP requests + webhook receiver |
| BullMQ worker | `src/jobs/worker.ts` | Invoice polling + expiry sweep |
| Postgres + Redis | managed services | Persistence + caching |

## Local setup

### 1. Prerequisites

- Node.js ≥ 20
- pnpm
- A Postgres instance (local or Render/Neon)
- A Redis instance (local or Railway/Upstash)
- An LNbits wallet (use [demo.lnbits.com](https://demo.lnbits.com) for development)

### 2. Clone and install

```bash
git clone <repo-url>
cd zap-backend
pnpm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string
- `LNBITS_BASE_URL` + `LNBITS_INVOICE_KEY` — from your LNbits wallet's "API info" tab
- `PUBLISHER_JWT_SECRET`, `READER_JWT_SECRET`, `INTERNAL_API_SECRET` — generate with:
  ```bash
  openssl rand -hex 32
  ```

### 4. Run database migrations

```bash
pnpm exec prisma migrate deploy
```

### 5. Start the API server

```bash
pnpm dev
# or for production:
pnpm start
```

### 6. Start the BullMQ worker (separate terminal)

```bash
pnpm exec tsx src/jobs/worker.ts
```

---

## Webhook setup (LNbits, local dev)

LNbits pushes a POST to `/webhooks/lightning` when an invoice is paid. For local development, you need a public URL. Use [ngrok](https://ngrok.com):

```bash
# Install ngrok, then:
ngrok http 3001
```

Copy the HTTPS forwarding URL (e.g. `https://abc123.ngrok-free.app`) and set it in `.env`:

```
WEBHOOK_BASE_URL=https://abc123.ngrok-free.app
```

Restart the API server. New invoices created after this point will register the webhook URL with LNbits automatically.

> **Note:** The polling worker (`PollInvoice` job) also detects paid invoices independently every 5 seconds. Webhooks speed up confirmation but are not required for correctness.

---

## LNbits test wallet setup

1. Go to [demo.lnbits.com](https://demo.lnbits.com) (or your own LNbits instance)
2. Create a new wallet
3. Click the wallet name → **API info** tab
4. Copy the **Invoice/read key** → `LNBITS_INVOICE_KEY`
5. Set `LNBITS_BASE_URL` to the base URL of your LNbits instance
6. Fund the wallet with test sats from [testnet faucet](https://testnet-faucet.mempool.co/) (if using testnet) or ask a friend for mainnet sats

---

## Testing

### Unit + integration tests (no Lightning required)

```bash
pnpm test:run
```

This runs all tests under `tests/` **except** `tests/integration/lightning/` (which require a funded wallet and are excluded from CI).

### Watch mode

```bash
pnpm test
```

### Lightning integration tests (real LNbits)

Set up a separate test wallet (not the same wallet as dev — test invoices will be created and paid):

```bash
TEST_LNBITS_BASE_URL=https://demo.lnbits.com \
TEST_LNBITS_INVOICE_KEY=your_test_wallet_key \
pnpm exec vitest --reporter verbose tests/integration/lightning
```

---

## API surface

### Public (readers)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/articles` | List published articles (no fullBody) |
| `GET` | `/api/articles/:slug` | Single article (no fullBody) |
| `POST` | `/api/invoices` | Create a Lightning invoice |
| `GET` | `/api/invoices/:hash/status` | Poll for payment status + JWT |
| `POST` | `/api/articles/:slug/unlock` | Exchange JWT for fullBody (requires `X-Internal-Secret`) |

### Publisher (requires `Authorization: Bearer <token>`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register publisher account |
| `POST` | `/api/auth/login` | Login, receive JWT |
| `GET` | `/api/auth/me` | Authenticated publisher profile |
| `POST` | `/api/articles` | Create article |
| `PATCH` | `/api/articles/:id` | Update article |
| `DELETE` | `/api/articles/:id` | Unpublish + cancel pending invoices |
| `GET` | `/api/publisher/articles` | All articles with revenue stats |
| `GET` | `/api/publisher/articles/:id/invoices` | Paginated invoice history |
| `GET` | `/api/publisher/stats` | Aggregate revenue + article counts |

### Server-to-server

| Method | Path | Description |
|---|---|---|
| `POST` | `/webhooks/lightning` | Receive payment notifications from Lightning node |
| `GET` | `/health` | DB + Redis + Lightning health check |

---

## Production deployment

Both the API server and BullMQ worker require a persistent process (not serverless):

- **Railway** or **Render**: deploy `src/index.ts` and `src/jobs/worker.ts` as two separate services
- **Postgres**: Render, Neon, or Supabase
- **Redis**: Railway or Upstash (confirm Upstash supports BullMQ's `maxRetriesPerRequest: null` before committing)

Set `NODE_ENV=production` and `WEBHOOK_BASE_URL` to your deployed API URL.

Both processes handle `SIGTERM` gracefully:
- API server: drains in-flight requests (max 10s) then exits
- Worker: finishes current job, stops picking up new ones, then exits
