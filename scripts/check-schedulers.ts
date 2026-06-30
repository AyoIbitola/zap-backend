import 'dotenv/config'
import { Queue } from 'bullmq'
import Redis from 'ioredis'

const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null, enableReadyCheck: false })
const q = new Queue('invoice-sweep', { connection: conn })
const schedulers = await q.getJobSchedulers()
console.log(JSON.stringify(schedulers, null, 2))
await q.close()
await conn.disconnect()
