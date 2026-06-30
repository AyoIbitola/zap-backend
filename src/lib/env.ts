const ALWAYS_REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'LIGHTNING_PROVIDER',
  'PUBLISHER_JWT_SECRET',
  'READER_JWT_SECRET',
  'INTERNAL_API_SECRET',
]

const LNBITS_REQUIRED = ['LNBITS_BASE_URL', 'LNBITS_INVOICE_KEY']
const LND_REQUIRED = ['LND_BASE_URL', 'LND_MACAROON_HEX', 'LND_TLS_CERT_BASE64']

export function validateEnv(): void {
  const missing = ALWAYS_REQUIRED.filter((key) => !process.env[key])

  const provider = process.env.LIGHTNING_PROVIDER
  if (provider === 'LNBITS') {
    missing.push(...LNBITS_REQUIRED.filter((key) => !process.env[key]))
  } else if (provider === 'LND') {
    missing.push(...LND_REQUIRED.filter((key) => !process.env[key]))
  }

  if (missing.length > 0) {
    console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`)
    process.exit(1)
  }
}
