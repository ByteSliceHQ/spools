import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import { apiGet, apiPost } from '../../src/server/mailbox'
import { appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import type { Fetch } from '../../src/server/runtime/http'
import { testRuntime } from '../../src/testing/run'

// Calls to Gmail, Google Calendar and Microsoft Graph: when they are tried
// again, and when they never are. A stand-in answers each request in turn.

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

function provider(...answers: (() => Response)[]) {
  const seen: number[] = []

  const fetch: Fetch = async () => {
    seen.push(Date.now())
    return (answers[Math.min(seen.length - 1, answers.length - 1)] ?? (() => json({})))()
  }

  const rt = testRuntime(appLayer({ fetch, auth: Auth.layerTest([]) }))

  const run = <A, E>(program: Effect.Effect<A, E>) =>
    rt.runPromise(program).finally(() => rt.dispose())

  return { seen, rt, run }
}

const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

describe('reads', () => {
  test('a busy provider is asked again, waiting as long as it says', async () => {
    const p = provider(
      () => json({}, 429, { 'retry-after': '1' }),
      () => json({ messages: [] }),
    )

    const result = await p.rt.runPromise(apiGet(url, 'token')).finally(() => p.rt.dispose())

    expect(result).toEqual({ messages: [] })
    expect(p.seen.length).toBe(2)
    expect((p.seen[1] ?? 0) - (p.seen[0] ?? 0)).toBeGreaterThanOrEqual(900)
  })

  test('a grant that is gone is not asked again, and says to reconnect', async () => {
    const p = provider(() => json({}, 401))

    const error = await p.rt
      .runPromise(Effect.flip(apiGet(url, 'token')))
      .finally(() => p.rt.dispose())

    expect(error).toMatchObject({ kind: 'account', status: 401 })
    expect(error.message).toBe('gmail.googleapis.com denied access (401). Reconnect the account.')
    expect(p.seen.length).toBe(1)
  })

  test('three tries at most, then the sync is told to try later', async () => {
    const p = provider(() => json({}, 503))

    const error = await p.rt
      .runPromise(Effect.flip(apiGet(url, 'token')))
      .finally(() => p.rt.dispose())

    expect(error).toMatchObject({ kind: 'api', status: 503 })
    expect(p.seen.length).toBe(3)
  })
})

describe('sending', () => {
  test('an email is never sent twice, even when the provider looks busy', async () => {
    const p = provider(() => json({}, 503))

    await p.rt
      .runPromise(
        Effect.flip(
          apiPost('https://graph.microsoft.com/v1.0/me/sendMail', 'token', { message: {} }),
        ),
      )
      .finally(() => p.rt.dispose())

    expect(p.seen.length).toBe(1)
  })
})
