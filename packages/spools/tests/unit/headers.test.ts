import { describe, expect, test } from 'bun:test'

import { withSecurityHeaders } from '../../src/server/headers'

describe('the headers every answer carries', () => {
  test('a page may not be framed by another site, and is the type it says', () => {
    const response = withSecurityHeaders(new Response('<p>hi</p>'))

    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test("an answer's own policy is kept", () => {
    const response = withSecurityHeaders(
      new Response('file', {
        headers: { 'content-security-policy': "default-src 'none'; sandbox" },
      }),
    )

    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  test('an answer whose headers cannot be changed is passed on with them added', async () => {
    const upstream = Response.redirect('https://example.com/next', 302)
    const fixed = new Response('stream', { status: 200, headers: { 'x-upstream': '1' } })
    Object.freeze(fixed.headers)

    const response = withSecurityHeaders(upstream)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://example.com/next')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  test('the body and status survive', async () => {
    const response = withSecurityHeaders(new Response('made', { status: 201 }))

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('made')
  })
})
