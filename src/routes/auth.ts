import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { signPublisherJwt } from '../lib/jwt.js'
import { publisherAuth } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import type { AppEnv } from '../types/index.js'

const auth = new Hono<AppEnv>()

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

auth.post('/register', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const result = registerSchema.safeParse(body)
  if (!result.success) {
    return c.json({ error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' }, 422)
  }

  const { email, password, displayName } = result.data

  const existing = await prisma.publisher.findUnique({ where: { email } })
  if (existing) {
    return c.json({ error: 'email_taken', message: 'Email already registered' }, 400)
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const publisher = await prisma.publisher.create({
    data: { email, passwordHash, displayName },
    select: { id: true, email: true, displayName: true },
  })

  const token = await signPublisherJwt({
    publisherId: publisher.id,
    email: publisher.email,
    role: 'publisher',
  })

  setCookie(c, 'publisher_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge: 86400,
    path: '/',
  })

  return c.json({ ...publisher, accessToken: token, expiresIn: 86400 }, 201)
})

// 10 login attempts per IP per 15 minutes
auth.post('/login', rateLimit({ limit: 10, windowMs: 15 * 60 * 1000 }), async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const result = loginSchema.safeParse(body)
  if (!result.success) {
    return c.json({ error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' }, 422)
  }

  const { email, password } = result.data

  const publisher = await prisma.publisher.findUnique({ where: { email } })
  if (!publisher) {
    return c.json({ error: 'invalid_credentials', message: 'Invalid email or password' }, 401)
  }

  const valid = await bcrypt.compare(password, publisher.passwordHash)
  if (!valid) {
    return c.json({ error: 'invalid_credentials', message: 'Invalid email or password' }, 401)
  }

  const token = await signPublisherJwt({
    publisherId: publisher.id,
    email: publisher.email,
    role: 'publisher',
  })

  setCookie(c, 'publisher_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge: 86400,
    path: '/',
  })

  return c.json({ accessToken: token, expiresIn: 86400 })
})

auth.get('/me', publisherAuth, async (c) => {
  const { publisherId } = c.get('publisher')

  const publisher = await prisma.publisher.findUnique({
    where: { id: publisherId },
    select: { id: true, email: true, displayName: true, bio: true, createdAt: true },
  })

  if (!publisher) {
    return c.json({ error: 'not_found', message: 'Publisher not found' }, 404)
  }

  return c.json(publisher)
})

// PATCH /api/auth/profile — update display name, email, bio
auth.patch('/profile', publisherAuth, async (c) => {
  const { publisherId } = c.get('publisher')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const schema = z.object({
    displayName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    bio: z.string().max(300).optional(),
  }).strict()

  const result = schema.safeParse(body)
  if (!result.success) {
    return c.json({ error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' }, 422)
  }

  if (result.data.email) {
    const conflict = await prisma.publisher.findFirst({
      where: { email: result.data.email, id: { not: publisherId } },
    })
    if (conflict) {
      return c.json({ error: 'email_taken', message: 'Email already in use' }, 400)
    }
  }

  const updated = await prisma.publisher.update({
    where: { id: publisherId },
    data: result.data,
    select: { id: true, email: true, displayName: true, bio: true },
  })

  return c.json(updated)
})

// POST /api/auth/change-password
auth.post('/change-password', publisherAuth, async (c) => {
  const { publisherId } = c.get('publisher')

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON' }, 422)
  }

  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  })

  const result = schema.safeParse(body)
  if (!result.success) {
    return c.json({ error: 'validation_error', message: result.error.errors[0]?.message ?? 'Validation failed' }, 422)
  }

  const publisher = await prisma.publisher.findUnique({
    where: { id: publisherId },
    select: { passwordHash: true },
  })

  if (!publisher) {
    return c.json({ error: 'not_found', message: 'Publisher not found' }, 404)
  }

  const valid = await bcrypt.compare(result.data.currentPassword, publisher.passwordHash)
  if (!valid) {
    return c.json({ error: 'invalid_credentials', message: 'Current password is incorrect' }, 401)
  }

  const passwordHash = await bcrypt.hash(result.data.newPassword, 12)
  await prisma.publisher.update({
    where: { id: publisherId },
    data: { passwordHash },
  })

  return c.json({ success: true })
})

// POST /api/auth/logout
auth.post('/logout', (c) => {
  setCookie(c, 'publisher_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge: 0,
    path: '/',
  })
  return c.json({ success: true })
})

export default auth
