import { z } from '@hono/zod-openapi'

export const CreateInvoiceSchema = z
  .object({
    articleId: z.string().uuid(),
    readerFingerprint: z.string().max(256).optional().openapi({
      description:
        'Opaque string you provide to identify the reader session, used only for dedup. ' +
        'Hash any PII before sending. If omitted, a random fingerprint is generated.',
    }),
  })
  .openapi('CreateInvoiceRequest')

export const InvoiceCreateResponseSchema = z
  .object({
    paymentHash: z.string(),
    invoiceString: z.string().openapi({ example: 'lnbc500n1pjx8v2cpp5...' }),
    amountSats: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    status: z.enum(['PENDING']),
  })
  .openapi('InvoiceCreateResponse')

export const PaymentHashParamSchema = z.object({
  paymentHash: z.string().regex(/^[0-9a-f]{64}$/).openapi({
    param: { name: 'paymentHash', in: 'path' },
    description: '64-character hex payment hash',
  }),
})

export const InvoiceStatusResponseSchema = z
  .object({
    paymentHash: z.string(),
    status: z.enum(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']),
    amountSats: z.number().int().positive(),
    articleId: z.string().uuid(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    confirmedAt: z.string().datetime().nullable(),
    accessToken: z.string().optional().openapi({
      description: 'Present only within 60 seconds of payment confirmation.',
    }),
  })
  .openapi('InvoiceStatusResponse')

export const VerifyAccessTokenSchema = z
  .object({
    accessToken: z.string().min(1),
    articleId: z.string().uuid(),
  })
  .openapi('VerifyAccessTokenRequest')

export const VerifyAccessTokenResponseSchema = z
  .union([
    z.object({
      valid: z.literal(true),
      articleId: z.string().uuid(),
      expiresAt: z.string().datetime(),
    }),
    z.object({
      valid: z.literal(false),
      reason: z.enum(['token_expired', 'wrong_article', 'token_revoked', 'invalid_signature']),
    }),
  ])
  .openapi('VerifyAccessTokenResponse')

export const InvoiceListQuerySchema = z.object({
  articleId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export const InvoiceListResponseSchema = z
  .object({
    invoices: z.array(InvoiceStatusResponseSchema.omit({ accessToken: true })),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('InvoiceListResponse')
