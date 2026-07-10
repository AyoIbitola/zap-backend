import crypto from 'node:crypto'

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`
}

// Same scheme documented for developers in Section 8.3 of the API infra PRD:
// HMAC-SHA256(key = endpoint secret, input = evtId + "." + timestamp + "." + rawBodyString)
export function signPayload(secret: string, evtId: string, timestamp: number, rawBody: string): string {
  const toSign = `${evtId}.${timestamp}.${rawBody}`
  return `v1=${crypto.createHmac('sha256', secret).update(toSign).digest('hex')}`
}

export function verifySignature(
  secret: string,
  evtId: string,
  timestamp: number,
  rawBody: string,
  signatureHeader: string,
): boolean {
  const expected = signPayload(secret, evtId, timestamp, rawBody)
  const expectedHex = expected.slice(3)
  const receivedHex = signatureHeader.replace('v1=', '')

  if (expectedHex.length !== receivedHex.length) return false

  return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(receivedHex, 'hex'))
}
