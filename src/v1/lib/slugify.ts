import crypto from 'node:crypto'

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'article'
}

export function slugWithSuffix(title: string): string {
  return `${slugify(title)}-${crypto.randomBytes(3).toString('hex')}`
}
