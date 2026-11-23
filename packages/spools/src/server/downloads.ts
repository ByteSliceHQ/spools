import type { OpenedFile } from './runtime/files'

/**
 * How a file people uploaded is handed to a browser.
 *
 * Anyone on the team can upload anything, and /api/files/<id> is on the same
 * origin as the CRM, with its session. A page or a script opened from there
 * could act as whoever opened it. So only a few types that can't run anything
 * are shown in the browser, recognised by the file's extension; everything else
 * (HTML and SVG above all) is downloaded as plain bytes. What the uploader's
 * browser said a file was is never repeated.
 */

const SHOWN: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
])

/** A `Content-Disposition` header: the name in plain ASCII for old clients, and in full (RFC 5987). */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const whole = name.toWellFormed()
  const ascii = whole.replace(/[^ -~]|["\\%]/g, '_')

  const encoded = encodeURIComponent(whole).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** The type and disposition a file of this name is served with. */
export function servedAs(name: string): { contentType: string; disposition: string } {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const shown = SHOWN.get(extension)
  return shown
    ? { contentType: shown, disposition: disposition('inline', name) }
    : { contentType: 'application/octet-stream', disposition: disposition('attachment', name) }
}

/** A file's bytes as a response that can't run anything, and isn't kept by a cache. */
export function fileResponse(file: Extract<OpenedFile, { kind: 'bytes' }>): Response {
  const served = servedAs(file.name)

  const headers = new Headers({
    'content-type': served.contentType,
    'content-disposition': served.disposition,
    // The type above is what it is, whatever the bytes look like.
    'x-content-type-options': 'nosniff',
    // Opened as a page it would be one with no origin, no scripts and nothing to load.
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
  })

  // A store that doesn't say how big the file is leaves the length to the stream.
  if (file.sizeBytes !== null) {
    headers.set('content-length', String(file.sizeBytes))
  }

  return new Response(file.body, { headers })
}

/** A redirect to a link the file store signed for one file. */
export const linkResponse = (url: string): Response =>
  new Response(null, {
    status: 302,
    headers: { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
