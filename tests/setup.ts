import 'dotenv/config'
import { beforeAll, afterAll } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { getRedis } from '../src/lib/redis.js'

beforeAll(async () => {
  // Pre-warm cloud connections so individual tests don't absorb the connection latency
  await Promise.all([
    prisma.$queryRaw`SELECT 1`,
    getRedis().ping(),
  ])
})

afterAll(async () => {
  await prisma.$disconnect()
  getRedis().disconnect()
})
