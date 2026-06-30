import Redis from 'ioredis'

let client: Redis | null = null

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    })

    client.on('error', (err) => {
      console.error('[redis] connection error:', err.message)
    })
  }
  return client
}

export { Redis }
