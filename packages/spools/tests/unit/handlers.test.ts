import { afterEach, describe, expect, test } from 'bun:test'

import { apiRoute, cronRoute, publicRoute } from '../../src/server/handlers'

// What an app's own endpoints are written with. The Spool here is the tests' own, whose
// development sign-in lets one person in (support/preload.ts). Server functions need a request
// being answered by TanStack Start: scripts/check-package.ts tries one in a real app.

const request = (headers?: Record<string, string>) =>
  new Request('http://localhost/api/mine', { headers })

function signedOut() {
  process.env['DEV_AUTH_SIGNED_OUT'] = '1'
}

afterEach(() => {
  delete process.env['DEV_AUTH_SIGNED_OUT']
  delete process.env['CRON_SECRET']
})

describe('an endpoint', () => {
  const mine = apiRoute<{ id: string }>('mine', ({ params, user }) =>
    Response.json({ id: params.id, email: user.email }),
  )

  test('gets its params and the person', async () => {
    const response = await mine({ request: request(), params: { id: '7' } })
    expect(await response.json()).toEqual({ id: '7', email: expect.stringContaining('@') })
  })

  test('answers 401 to someone signed out', async () => {
    signedOut()
    expect((await mine({ request: request(), params: { id: '7' } })).status).toBe(401)
  })

  test('answers 500 with what was thrown', async () => {
    const broken = apiRoute('mine', () => {
      throw new Error('That part is out of stock.')
    })

    const response = await broken({ request: request(), params: {} })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'That part is out of stock.' })
  })

  test('for webhooks runs with nobody signed in', async () => {
    signedOut()
    const response = await publicRoute('mine', () => new Response('ok'))({ request: request() })
    expect(await response.text()).toBe('ok')
  })

  test('for a scheduled job needs the secret', async () => {
    const job = cronRoute('mine', () => new Response('done'))
    expect((await job({ request: request() })).status).toBe(401)

    process.env['CRON_SECRET'] = 'a-secret-of-some-length'
    expect((await job({ request: request({ authorization: 'Bearer wrong' }) })).status).toBe(401)

    const response = await job({
      request: request({ authorization: 'Bearer a-secret-of-some-length' }),
    })

    expect(await response.text()).toBe('done')
  })
})
