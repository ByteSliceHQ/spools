import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (value: string) => createHash('sha256').update(value).digest()

/** Whether a request carries `Authorization: Bearer <secret>`, compared in constant time. */
export function bearerMatches(headers: Headers, secret: string): boolean {
  const header = headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return timingSafeEqual(digest(token), digest(secret))
}

/**
 * Constant-time bearer check for the /api/cron routes, for code not yet on
 * Effect (the Effect version is `cronAuthorized` in boundary.ts). A scheduler
 * sends `Authorization: Bearer $CRON_SECRET`. False when CRON_SECRET is unset or shorter than 16 characters.
 */
export function isCronAuthorized(request: Request): boolean {
  const expected = process.env['CRON_SECRET']
  return !!expected && expected.length >= 16 && bearerMatches(request.headers, expected)
}
