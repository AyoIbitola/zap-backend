import { prisma } from '../lib/prisma.js'
import { webhookDeliveryQueue } from '../jobs/queue.js'

interface InvoicePaidPayload {
  paymentHash: string
  articleId: string
  readerFingerprint: string
  amountSats: number
  accessToken: string | null
}

// Fire-and-forget: looks up matching endpoints and enqueues one delivery job per endpoint.
// Never awaited by the caller (InvoiceService.confirm) — a slow lookup or Redis hiccup here
// must never delay the payment confirmation response.
export function enqueueInvoicePaidWebhooks(data: InvoicePaidPayload): void {
  prisma.article
    .findUnique({ where: { id: data.articleId }, select: { title: true, publisherId: true } })
    .then(async (article) => {
      if (!article) return

      const endpoints = await prisma.webhookEndpoint.findMany({
        where: { publisherId: article.publisherId, enabled: true, events: { hasSome: ['invoice.paid', '*'] } },
        select: { id: true },
      })

      const paidAt = new Date().toISOString()

      for (const endpoint of endpoints) {
        webhookDeliveryQueue
          .add('deliver', {
            endpointId: endpoint.id,
            event: 'invoice.paid',
            payload: {
              paymentHash: data.paymentHash,
              articleId: data.articleId,
              articleTitle: article.title,
              amountSats: data.amountSats,
              readerFingerprint: data.readerFingerprint,
              accessToken: data.accessToken,
              paidAt,
            },
          })
          .catch((err) => console.error('[webhooks] failed to enqueue webhook-delivery job:', (err as Error).message))
      }
    })
    .catch((err) => console.error('[webhooks] failed to look up webhook endpoints:', (err as Error).message))
}
