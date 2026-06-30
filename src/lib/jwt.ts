import { SignJWT, jwtVerify } from 'jose'
import type { PublisherPayload, ReaderPayload } from '../types/index.js'

function publisherSecret() {
  return new TextEncoder().encode(process.env.PUBLISHER_JWT_SECRET!)
}

function readerSecret() {
  return new TextEncoder().encode(process.env.READER_JWT_SECRET!)
}

export async function signPublisherJwt(payload: PublisherPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(publisherSecret())
}

export async function verifyPublisherJwt(token: string): Promise<PublisherPayload> {
  const { payload } = await jwtVerify(token, publisherSecret())
  return payload as unknown as PublisherPayload
}

export async function signReaderJwt(
  payload: ReaderPayload,
  ttlHours: number,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(readerSecret())
}

export async function verifyReaderJwt(token: string): Promise<ReaderPayload> {
  const { payload } = await jwtVerify(token, readerSecret())
  return payload as unknown as ReaderPayload
}
