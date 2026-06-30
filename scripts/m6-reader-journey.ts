/**
 * M6 Acceptance check — Full reader journey
 *
 * 1. Publisher creates + publishes article
 * 2. Reader creates invoice → PENDING
 * 3. Payment confirmed (via webhook) → PAID + accessToken
 * 4. Reader calls unlock endpoint → fullBody returned
 * 5. Unlock without token → 401
 * 6. Unlock with wrong X-Internal-Secret → 403
 * 7. Unlock with valid token for wrong slug → 401
 * 8. GET /api/articles/:slug never returns fullBody (content gate)
 */
import 'dotenv/config'

const BASE = 'http://localhost:3001'
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET!
const FULL_BODY_CONTENT = '<p>This is the paid full body content — should only appear on unlock.</p>'

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, body: await res.json() }
}

const results: { test: string; pass: boolean; detail?: string }[] = []
function check(test: string, pass: boolean, detail?: string) {
  results.push({ test, pass, detail })
}

// ─── 1. Publisher auth ────────────────────────────────────────────────────────
const loginRes = await post('/api/auth/login', { email: 'm4test@example.com', password: 'password123' })
const TOKEN = (loginRes.body as { accessToken: string }).accessToken
const authHeader = { Authorization: `Bearer ${TOKEN}` }

// ─── 2. Create + publish article ──────────────────────────────────────────────
const slug = `m6-journey-${Date.now()}`
const artRes = await post('/api/articles', {
  title: 'M6 Reader Journey Article',
  slug,
  teaserBody: '<p>This is the teaser — free to read.</p>',
  fullBody: FULL_BODY_CONTENT,
  priceSats: 1,
}, authHeader)
const article = artRes.body as { id: string }

await post(`/api/articles/${article.id}`, { published: true }, { ...authHeader, 'X-HTTP-Method-Override': 'PATCH' })
// Use fetch directly for PATCH
await fetch(`${BASE}/api/articles/${article.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ published: true }),
})

// ─── 3. Verify GET /api/articles/:slug never returns fullBody ──────────────────
const publicArticle = await get(`/api/articles/${slug}`)
check(
  'GET /api/articles/:slug does not include fullBody',
  !('fullBody' in (publicArticle.body as object)),
)

// ─── 4. Reader creates invoice ────────────────────────────────────────────────
const invRes = await post('/api/invoices', { articleId: article.id, readerFingerprint: 'm6-reader-fp' })
const invoice = invRes.body as { paymentHash: string }
check('POST /api/invoices returns 201', invRes.status === 201)

const pendingStatus = await get(`/api/invoices/${invoice.paymentHash}/status`)
check('initial status is PENDING', (pendingStatus.body as { status: string }).status === 'PENDING')

// ─── 5. Webhook fires (simulates payment) ────────────────────────────────────
const whRes = await post('/webhooks/lightning', { payment_hash: invoice.paymentHash })
check('webhook returns 200', whRes.status === 200)

// ─── 6. Status endpoint returns PAID + accessToken ────────────────────────────
const paidStatus = await get(`/api/invoices/${invoice.paymentHash}/status`)
const paidBody = paidStatus.body as { status: string; accessToken?: string }
check('status is PAID after webhook', paidBody.status === 'PAID')
check('accessToken present in status response', typeof paidBody.accessToken === 'string')

const accessToken = paidBody.accessToken!

// ─── 7. Unlock with valid token → fullBody returned ──────────────────────────
const unlockRes = await post(`/api/articles/${slug}/unlock`, { accessToken }, {
  'X-Internal-Secret': INTERNAL_SECRET,
})
check('unlock returns 200', unlockRes.status === 200)
check(
  'unlock returns correct fullBody',
  (unlockRes.body as { fullBody?: string }).fullBody === FULL_BODY_CONTENT,
)
check(
  'unlock returns articleId',
  (unlockRes.body as { articleId?: string }).articleId === article.id,
)

// ─── 8. Unlock without token → 400 ───────────────────────────────────────────
const noTokenRes = await post(`/api/articles/${slug}/unlock`, {}, {
  'X-Internal-Secret': INTERNAL_SECRET,
})
check('unlock without accessToken returns 400', noTokenRes.status === 400)

// ─── 9. Unlock with bad token → 401 ──────────────────────────────────────────
const badTokenRes = await post(`/api/articles/${slug}/unlock`, { accessToken: 'bad.jwt.token' }, {
  'X-Internal-Secret': INTERNAL_SECRET,
})
check('unlock with invalid token returns 401', badTokenRes.status === 401)

// ─── 10. Unlock with wrong X-Internal-Secret → 403 ───────────────────────────
const badSecretRes = await post(`/api/articles/${slug}/unlock`, { accessToken }, {
  'X-Internal-Secret': 'wrong-secret',
})
check('unlock with wrong X-Internal-Secret returns 403', badSecretRes.status === 403)

// ─── 11. Unlock with valid token for wrong slug → 401 (wrong_article) ────────
const wrongSlug = `m6-wrong-slug-${Date.now()}`
const wrongArtRes = await post('/api/articles', {
  title: 'Wrong Article',
  slug: wrongSlug,
  teaserBody: '<p>Other</p>',
  fullBody: '<p>Other content</p>',
  priceSats: 1,
}, authHeader)
await fetch(`${BASE}/api/articles/${(wrongArtRes.body as { id: string }).id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ published: true }),
})
const wrongSlugRes = await post(`/api/articles/${wrongSlug}/unlock`, { accessToken }, {
  'X-Internal-Secret': INTERNAL_SECRET,
})
check('unlock with token for wrong article returns 401', wrongSlugRes.status === 401)

// ─── Print results ────────────────────────────────────────────────────────────
console.log('\n=== M6 ACCEPTANCE RESULTS ===')
for (const { test, pass, detail } of results) {
  console.log(`${pass ? 'PASS ✓' : 'FAIL ✗'}  ${test}${detail ? `  (${detail})` : ''}`)
}
const allPass = results.every((r) => r.pass)
console.log(`\n${allPass ? 'All checks passed.' : 'Some checks FAILED.'}`)
process.exit(allPass ? 0 : 1)
