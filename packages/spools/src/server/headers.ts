/**
 * Headers every answer of a Spool carries, unless the answer set its own (a
 * download has a stricter policy: downloads.ts).
 *
 * - Nothing outside the CRM may put it in a frame, so a page elsewhere can't
 *   have someone click a button here without seeing it.
 * - The browser takes each answer as the type it is sent as.
 * - A `<base>` or a plug-in is never part of a page of the CRM.
 */
const HEADERS: readonly (readonly [string, string])[] = [
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'SAMEORIGIN'],
  ['content-security-policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'"],
]

export function withSecurityHeaders(response: Response): Response {
  const missing = HEADERS.filter(([name]) => !response.headers.has(name))

  // A switch of protocol has no headers of ours to carry.
  if (missing.length === 0 || response.status === 101) {
    return response
  }

  try {
    for (const [name, value] of missing) {
      response.headers.set(name, value)
    }

    return response
  } catch {
    // An answer passed on from another server (the assistant's stream) has headers that can't be changed.
    const headers = new Headers(response.headers)

    for (const [name, value] of missing) {
      headers.set(name, value)
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
