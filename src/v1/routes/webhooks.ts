import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { prisma } from '../../lib/prisma.js'
import { generateWebhookSecret } from '../../lib/webhookSignature.js'
import { deliverWebhookOnce } from '../../jobs/deliverWebhookOnce.js'
import { apiKeyAuth } from '../middleware/apiKeyAuth.js'
import { requireScope } from '../middleware/requireScope.js'
import { rateLimitGroup, webhookTestRateLimit } from '../middleware/rateLimit.js'
import { errorResponse } from '../lib/errorResponse.js'
import { zodErrorHook } from '../lib/validationHook.js'
import {
  WebhookEndpointSchema,
  WebhookListResponseSchema,
  CreateWebhookSchema,
  CreateWebhookResponseSchema,
  UpdateWebhookSchema,
  WebhookIdParamSchema,
  DeleteWebhookResponseSchema,
  WebhookTestResponseSchema,
} from '../schemas/webhook.schema.js'
import { ErrorSchema, ValidationErrorSchema } from '../schemas/error.schema.js'
import type { V1Env } from '../types.js'

const webhooks = new OpenAPIHono<V1Env>({ defaultHook: zodErrorHook })

webhooks.use(
  '*',
  rateLimitGroup([
    { name: 'webhooks-create', test: (c) => c.req.method === 'POST' && c.req.path === '/v1/webhooks', limit: 20, windowMs: 3_600_000 },
  ]),
)
webhooks.use('*', apiKeyAuth)

const MAX_ENDPOINTS_PER_PUBLISHER = parseInt(process.env.WEBHOOK_MAX_ENDPOINTS_PER_PUBLISHER ?? '10', 10)

function serializeEndpoint(e: { id: string; url: string; description: string | null; enabled: boolean; events: string[]; createdAt: Date }) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    enabled: e.enabled,
    events: e.events,
    createdAt: e.createdAt.toISOString(),
  }
}

// ─── GET /v1/webhooks ────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/webhooks',
  tags: ['Webhooks'],
  summary: 'List Webhook Endpoints',
  description: 'Lists registered webhook endpoints for your publisher account. The signing secret is never returned after creation.',
  security: [{ ApiKeyAuth: ['webhooks:manage'] }],
  middleware: [requireScope('webhooks:manage')] as const,
  responses: {
    200: { description: 'List of endpoints', content: { 'application/json': { schema: WebhookListResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the webhooks:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

webhooks.openapi(listRoute, async (c) => {
  const publisherId = c.get('publisherId')
  const rows = await prisma.webhookEndpoint.findMany({ where: { publisherId }, orderBy: { createdAt: 'desc' } })
  return c.json({ endpoints: rows.map(serializeEndpoint) }, 200)
})

// ─── POST /v1/webhooks ───────────────────────────────────────────────────────────

const createEndpointRoute = createRoute({
  method: 'post',
  path: '/webhooks',
  tags: ['Webhooks'],
  summary: 'Register A Webhook Endpoint',
  description:
    'Registers a new webhook endpoint. The HMAC signing secret (prefixed whsec_) is returned exactly once — ' +
    'store it to verify delivery signatures. A publisher can have at most 10 webhook endpoints.',
  security: [{ ApiKeyAuth: ['webhooks:manage'] }],
  middleware: [requireScope('webhooks:manage')] as const,
  request: { body: { content: { 'application/json': { schema: CreateWebhookSchema } }, required: true } },
  responses: {
    201: { description: 'Endpoint registered — secret shown once', content: { 'application/json': { schema: CreateWebhookResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the webhooks:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure, or endpoint limit reached', content: { 'application/json': { schema: ValidationErrorSchema } } },
    429: { description: 'Rate limit exceeded', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

webhooks.openapi(createEndpointRoute, async (c) => {
  const { url, description, events } = c.req.valid('json')
  const publisherId = c.get('publisherId')

  const count = await prisma.webhookEndpoint.count({ where: { publisherId } })
  if (count >= MAX_ENDPOINTS_PER_PUBLISHER) {
    return errorResponse(c, 422, 'validation_error', `You can register at most ${MAX_ENDPOINTS_PER_PUBLISHER} webhook endpoints.`, {
      fields: { url: 'Endpoint limit reached.' },
    })
  }

  const secret = generateWebhookSecret()

  const created = await prisma.webhookEndpoint.create({
    data: { publisherId, url, description, events, secret },
  })

  return c.json(
    {
      ...serializeEndpoint(created),
      secret,
      warning: 'Store this secret now. It will not be shown again. Use it to verify webhook signatures.',
    },
    201,
  )
})

// ─── PATCH /v1/webhooks/:id ──────────────────────────────────────────────────────

const updateRoute = createRoute({
  method: 'patch',
  path: '/webhooks/{id}',
  tags: ['Webhooks'],
  summary: 'Update A Webhook Endpoint',
  description: 'Updates an endpoint you own — toggle `enabled`, or change `url`, `description`, `events`.',
  security: [{ ApiKeyAuth: ['webhooks:manage'] }],
  middleware: [requireScope('webhooks:manage')] as const,
  request: {
    params: WebhookIdParamSchema,
    body: { content: { 'application/json': { schema: UpdateWebhookSchema } }, required: true },
  },
  responses: {
    200: { description: 'Updated endpoint', content: { 'application/json': { schema: WebhookEndpointSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the webhooks:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Endpoint not found', content: { 'application/json': { schema: ErrorSchema } } },
    422: { description: 'Field-level validation failure', content: { 'application/json': { schema: ValidationErrorSchema } } },
  },
})

webhooks.openapi(updateRoute, async (c) => {
  const { id } = c.req.valid('param')
  const body = c.req.valid('json')
  const publisherId = c.get('publisherId')

  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, publisherId } })
  if (!existing) {
    return errorResponse(c, 404, 'endpoint_not_found', 'Webhook endpoint not found.')
  }

  const updated = await prisma.webhookEndpoint.update({ where: { id }, data: body })

  return c.json(serializeEndpoint(updated), 200)
})

// ─── DELETE /v1/webhooks/:id ──────────────────────────────────────────────────────

const deleteRoute = createRoute({
  method: 'delete',
  path: '/webhooks/{id}',
  tags: ['Webhooks'],
  summary: 'Remove A Webhook Endpoint',
  description: 'Removes a webhook endpoint you own. Any deliveries still queued for it become no-ops.',
  security: [{ ApiKeyAuth: ['webhooks:manage'] }],
  middleware: [requireScope('webhooks:manage')] as const,
  request: { params: WebhookIdParamSchema },
  responses: {
    200: { description: 'Endpoint deleted', content: { 'application/json': { schema: DeleteWebhookResponseSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the webhooks:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Endpoint not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

webhooks.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid('param')
  const publisherId = c.get('publisherId')

  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, publisherId } })
  if (!existing) {
    return errorResponse(c, 404, 'endpoint_not_found', 'Webhook endpoint not found.')
  }

  await prisma.webhookEndpoint.delete({ where: { id } })

  return c.json({ id, deleted: true as const }, 200)
})

// ─── POST /v1/webhooks/:id/test ──────────────────────────────────────────────────

const testRoute = createRoute({
  method: 'post',
  path: '/webhooks/{id}/test',
  tags: ['Webhooks'],
  summary: 'Send A Test Event',
  description:
    'Sends a synthetic `webhook.test` event to the endpoint synchronously, so you can verify it is reachable ' +
    'and that your signature verification code works. Returns the response your server sent back.',
  security: [{ ApiKeyAuth: ['webhooks:manage'] }],
  middleware: [requireScope('webhooks:manage'), webhookTestRateLimit] as const,
  request: { params: WebhookIdParamSchema },
  responses: {
    200: { description: 'Test delivery result', content: { 'application/json': { schema: WebhookTestResponseSchema } } },
    429: { description: 'Too many test events for this endpoint', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Missing or invalid API key', content: { 'application/json': { schema: ErrorSchema } } },
    403: { description: 'Key lacks the webhooks:manage scope', content: { 'application/json': { schema: ErrorSchema } } },
    404: { description: 'Endpoint not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
})

webhooks.openapi(testRoute, async (c) => {
  const { id } = c.req.valid('param')
  const publisherId = c.get('publisherId')

  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, publisherId } })
  if (!endpoint) {
    return errorResponse(c, 404, 'endpoint_not_found', 'Webhook endpoint not found.')
  }

  const result = await deliverWebhookOnce(endpoint, 'webhook.test', { message: 'This is a test event from Zap.' }, 1)

  return c.json(
    {
      delivered: result.delivered,
      responseStatus: result.responseStatus,
      responseBody: result.responseBody,
      durationMs: result.durationMs,
    },
    200,
  )
})

export default webhooks
