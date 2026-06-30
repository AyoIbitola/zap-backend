import { Hono } from 'hono'

const rates = new Hono()

let cachedRate: number | null = null
let cacheTime = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// GET /api/rates/btc-usd
rates.get('/btc-usd', async (c) => {
  if (cachedRate && Date.now() - cacheTime < CACHE_TTL_MS) {
    return c.json({ usdPerBtc: cachedRate, cached: true })
  }

  try {
    const res = await fetch('https://blockchain.info/ticker', {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error('upstream error')
    const data = (await res.json()) as { USD?: { last?: number } }
    const rate = data.USD?.last
    if (!rate) throw new Error('no rate in response')
    cachedRate = rate
    cacheTime = Date.now()
    return c.json({ usdPerBtc: rate, cached: false })
  } catch {
    // Fall back to cached value if available, else return 503
    if (cachedRate) {
      return c.json({ usdPerBtc: cachedRate, cached: true })
    }
    return c.json({ error: 'rate_unavailable', message: 'BTC rate temporarily unavailable' }, 503)
  }
})

export default rates
