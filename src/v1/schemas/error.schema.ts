import { z } from '@hono/zod-openapi'

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'article_not_found' }),
    message: z.string().openapi({ example: 'Article does not exist or belongs to another publisher.' }),
    requestId: z.string().openapi({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
  })
  .openapi('Error')

export const ValidationErrorSchema = ErrorSchema.extend({
  fields: z.record(z.string()).optional().openapi({
    example: { priceSats: 'Must be a positive integer.' },
  }),
}).openapi('ValidationError')

export function errorContent(description: string, schema: typeof ErrorSchema = ErrorSchema) {
  return {
    description,
    content: { 'application/json': { schema } },
  }
}
