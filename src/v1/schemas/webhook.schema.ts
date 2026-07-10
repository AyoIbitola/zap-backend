import { z } from '@hono/zod-openapi'

export const WEBHOOK_EVENT_NAMES = ['invoice.paid', 'invoice.expired', 'invoice.cancelled'] as const

const EventsSchema = z
  .array(z.union([z.enum(WEBHOOK_EVENT_NAMES), z.literal('*')]))
  .min(1)
  .openapi({ description: 'Specific event names, or ["*"] for all events.' })

export const WebhookEndpointSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string().url(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    events: z.array(z.string()),
    createdAt: z.string().datetime(),
  })
  .openapi('WebhookEndpoint')

export const WebhookListResponseSchema = z.object({ endpoints: z.array(WebhookEndpointSchema) }).openapi('WebhookEndpointListResponse')

export const CreateWebhookSchema = z
  .object({
    url: z.string().url(),
    description: z.string().max(200).optional(),
    events: EventsSchema,
  })
  .openapi('CreateWebhookEndpointRequest')

export const CreateWebhookResponseSchema = WebhookEndpointSchema.extend({
  secret: z.string().openapi({
    description: 'HMAC secret, prefixed whsec_. Shown once — store it to verify delivery signatures.',
    example: 'whsec_Ab3Xk9mQr7...',
  }),
  warning: z.string(),
}).openapi('CreateWebhookEndpointResponse')

export const UpdateWebhookSchema = z
  .object({
    url: z.string().url().optional(),
    description: z.string().max(200).optional(),
    events: EventsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .openapi('UpdateWebhookEndpointRequest')

export const WebhookIdParamSchema = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
})

export const DeleteWebhookResponseSchema = z
  .object({ id: z.string().uuid(), deleted: z.literal(true) })
  .openapi('DeleteWebhookEndpointResponse')

export const WebhookTestResponseSchema = z
  .object({
    delivered: z.boolean(),
    responseStatus: z.number().int().nullable(),
    responseBody: z.string().nullable(),
    durationMs: z.number().int(),
  })
  .openapi('WebhookTestResponse')
