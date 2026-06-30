/**
 * AccessTokenService.validateAccessToken — unit tests (PRD Section 13)
 *
 * Scenarios:
 *   - Expired JWT → invalid_token
 *   - Tampered signature → invalid_token
 *   - Wrong articleId in token → wrong_article
 *   - DB row missing → token_revoked
 *   - Valid token for correct article → valid: true
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { SignJWT } from 'jose'

// Mock prisma — must be declared before any imports that transitively use it
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    accessToken: {
      findUnique: vi.fn(),
    },
  },
}))

// Redis is not called by validateAccessToken — no mock needed

import { validateAccessToken } from '../../src/services/accessToken.service.js'
import { prisma } from '../../src/lib/prisma.js'

const mockFindUnique = vi.mocked(prisma.accessToken.findUnique)

// Helpers — sign JWTs directly with jose to control expiry and secret
function readerKey() {
  return new TextEncoder().encode(process.env.READER_JWT_SECRET!)
}

async function signValid(articleId: string, fingerprint = 'fp-test') {
  return new SignJWT({ articleId, readerFingerprint: fingerprint })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(readerKey())
}

async function signExpired(articleId: string) {
  return new SignJWT({ articleId, readerFingerprint: 'fp-test' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(new Date(Date.now() - 7200_000))
    .setExpirationTime(new Date(Date.now() - 3600_000))  // 1h ago
    .sign(readerKey())
}

async function signTampered(articleId: string) {
  return new SignJWT({ articleId, readerFingerprint: 'fp-test' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(new TextEncoder().encode('wrong-secret-that-does-not-match-env'))
}

const ARTICLE_ID = 'article-unit-test-uuid'

describe('validateAccessToken', () => {
  beforeEach(() => {
    mockFindUnique.mockReset()
  })

  it('returns invalid_token for an expired JWT', async () => {
    const token = await signExpired(ARTICLE_ID)
    const result = await validateAccessToken(token, ARTICLE_ID)
    expect(result).toEqual({ valid: false, reason: 'invalid_token' })
  })

  it('returns invalid_token for a tampered signature', async () => {
    const token = await signTampered(ARTICLE_ID)
    const result = await validateAccessToken(token, ARTICLE_ID)
    expect(result).toEqual({ valid: false, reason: 'invalid_token' })
  })

  it('returns invalid_token for a completely malformed string', async () => {
    const result = await validateAccessToken('not.a.jwt', ARTICLE_ID)
    expect(result).toEqual({ valid: false, reason: 'invalid_token' })
  })

  it('returns wrong_article when articleId in JWT does not match requested article', async () => {
    const token = await signValid('different-article-id')
    // DB is not reached when articleId mismatches — mock not needed but set just in case
    mockFindUnique.mockResolvedValue(null)
    const result = await validateAccessToken(token, ARTICLE_ID)
    expect(result).toEqual({ valid: false, reason: 'wrong_article' })
  })

  it('returns token_revoked when AccessToken row is not in DB', async () => {
    const token = await signValid(ARTICLE_ID)
    mockFindUnique.mockResolvedValue(null)
    const result = await validateAccessToken(token, ARTICLE_ID)
    expect(result).toEqual({ valid: false, reason: 'token_revoked' })
  })

  it('returns valid for a correct token with a matching DB row', async () => {
    const token = await signValid(ARTICLE_ID, 'reader-fp')
    mockFindUnique.mockResolvedValue({
      id: 'at-id',
      tokenHash: 'hash',
      invoiceId: 'inv-id',
      articleId: ARTICLE_ID,
      readerFingerprint: 'reader-fp',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400_000),
    } as never)
    const result = await validateAccessToken(token, ARTICLE_ID)
    expect(result).toEqual({ valid: true, articleId: ARTICLE_ID, readerFingerprint: 'reader-fp' })
  })

  it('does not call DB when JWT is expired', async () => {
    const token = await signExpired(ARTICLE_ID)
    await validateAccessToken(token, ARTICLE_ID)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('does not call DB when articleId mismatches', async () => {
    const token = await signValid('other-article')
    await validateAccessToken(token, ARTICLE_ID)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })
})
