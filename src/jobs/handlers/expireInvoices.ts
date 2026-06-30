import { prisma } from '../../lib/prisma.js'
import { expireInvoice } from '../../services/invoice.service.js'

export async function handleExpireInvoices(): Promise<void> {
  const stale = await prisma.invoice.findMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    select: { paymentHash: true },
  })

  if (stale.length > 0) {
    console.log(`[sweep] expiring ${stale.length} stale invoice(s)`)
  }

  for (const invoice of stale) {
    await expireInvoice(invoice.paymentHash)
  }
}
