import type { Job } from 'bullmq'
import { prisma } from '../../lib/prisma.js'
import { getLightningProvider } from '../../lightning/index.js'
import { confirmInvoice, expireInvoice } from '../../services/invoice.service.js'

export async function handlePollInvoice(job: Job<{ paymentHash: string }>): Promise<void> {
  const { paymentHash } = job.data

  const invoice = await prisma.invoice.findUnique({
    where: { paymentHash },
    select: { status: true, expiresAt: true },
  })

  if (!invoice) {
    console.log(`[poll] invoice not found: ${paymentHash} — discarding job`)
    return
  }

  if (invoice.status !== 'PENDING') {
    console.log(`[poll] invoice ${paymentHash} already ${invoice.status} — discarding job`)
    return
  }

  await prisma.invoice.update({
    where: { paymentHash },
    data: { pollAttempts: { increment: 1 } },
  })

  const provider = getLightningProvider()
  const result = await provider.getInvoiceStatus(paymentHash)

  console.log(`[poll] ${paymentHash.slice(0, 12)}… status=${result.status} attempt=${job.attemptsMade + 1}`)

  if (result.status === 'PAID') {
    await confirmInvoice(paymentHash)
    console.log(`[poll] confirmed: ${paymentHash.slice(0, 12)}…`)
    return
  }

  if (result.status === 'EXPIRED' || new Date() > invoice.expiresAt) {
    await expireInvoice(paymentHash)
    console.log(`[poll] expired: ${paymentHash.slice(0, 12)}…`)
    return
  }

  // Still PENDING — BullMQ retries based on attempts + backoff config
  throw new Error('Invoice still pending — retry')
}
