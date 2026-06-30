import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { verifyReaderJwt, signReaderJwt } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'
import { getRedis } from '../lib/redis.js'

// ─── Validate ────────────────────────────────────────────────────────────────

type ValidationResult =
  | { valid: true; articleId: string; readerFingerprint: string }
  | { valid: false; reason: 'invalid_token' | 'wrong_article' | 'token_revoked' }

export async function validateAccessToken(
  rawJwt: string,
  articleId: string,
): Promise<ValidationResult> {
  // 1. Verify JWT signature and expiry
  let payload: { articleId: string; readerFingerprint: string }
  try {
    payload = await verifyReaderJwt(rawJwt)
  } catch {
    return { valid: false, reason: 'invalid_token' }
  }

  // 2. Check articleId matches the requested article
  if (payload.articleId !== articleId) {
    return { valid: false, reason: 'wrong_article' }
  }

  // 3. Look up AccessToken row by tokenHash (revocation check)
  const tokenHash = createHash('sha256').update(rawJwt).digest('hex')
  const tokenRow = await prisma.accessToken.findUnique({ where: { tokenHash } })
  if (!tokenRow) {
    return { valid: false, reason: 'token_revoked' }
  }

  return { valid: true, articleId: payload.articleId, readerFingerprint: payload.readerFingerprint }
}

// ─── Issue ───────────────────────────────────────────────────────────────────

export async function issueAccessToken(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  articleId: string,
  readerFingerprint: string,
): Promise<{ rawJwt: string; tokenHash: string }> {
  const ttlHours = parseInt(process.env.ACCESS_TOKEN_TTL_HOURS ?? '24', 10)
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000)

  const rawJwt = await signReaderJwt({ articleId, readerFingerprint }, ttlHours)
  const tokenHash = createHash('sha256').update(rawJwt).digest('hex')

  await tx.accessToken.create({
    data: { invoiceId, articleId, readerFingerprint, tokenHash, expiresAt },
  })

  return { rawJwt, tokenHash }
}

// ─── Post-commit Redis writes (called after transaction commits) ─────────────

export async function writeAccessTokenToRedis(
  rawJwt: string,
  tokenHash: string,
  articleId: string,
): Promise<void> {
  const redis = getRedis()
  const ttlSecs = parseInt(process.env.ACCESS_TOKEN_TTL_HOURS ?? '24', 10) * 3600

  await Promise.all([
    // Fast revocation lookup
    redis.setex(`access:${articleId}:${tokenHash}`, ttlSecs, '1'),
    // Short-lived JWT store for the polling status endpoint (60s window)
    redis.setex(`jwt:${tokenHash}`, 60, rawJwt),
  ])
}
