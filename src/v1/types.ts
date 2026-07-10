export const ALL_SCOPES = [
  'articles:write',
  'articles:read',
  'invoices:create',
  'invoices:read',
  'analytics:read',
  'webhooks:manage',
  'keys:manage',
] as const

export type Scope = (typeof ALL_SCOPES)[number]

export type V1Variables = {
  requestId: string
  publisherId: string
  apiKeyId?: string
  keyType?: 'SECRET' | 'PUBLISHABLE'
  keyScopes?: string[]
  keyPrefix?: string
  authMethod?: 'publisher' | 'apikey'
}

export type V1Env = {
  Variables: V1Variables
}
