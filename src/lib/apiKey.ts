import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

export type KeyType = 'SECRET' | 'PUBLISHABLE'

export interface GeneratedKey {
  raw: string // shown to publisher once, then discarded
  hash: string // stored in database
  prefix: string // first 16 chars, stored for display and fast lookup
  type: KeyType
}

export async function generateApiKey(type: KeyType): Promise<GeneratedKey> {
  const typePrefix = type === 'SECRET' ? 'zap_sk_' : 'zap_pk_'
  const entropy = crypto.randomBytes(32).toString('base64url')
  const raw = `${typePrefix}${entropy}`
  const prefix = raw.slice(0, 16) // BEFORE hashing
  const hash = await bcrypt.hash(raw, 12) // AFTER prefix extraction

  return { raw, hash, prefix, type }
}

export async function verifyApiKey(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash)
}
