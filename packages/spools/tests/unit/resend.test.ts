import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import { deliveryOf } from '../../src/adapters/email/resend/server'
import { appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { Email } from '../../src/server/runtime/email'
import { testRuntime } from '../support/run'

// Sending through Resend: an email is sent again only when it carries an
// idempotency key, so Resend can drop the repeat. The Resend SDK calls the
// global fetch, so a stand-in answers there.

const saved = {
  fetch: globalThis.fetch,
  key: process.env['RESEND_API_KEY'],
  from: process.env['EMAIL_FROM'],
}

let answers: Response[] = []
let calls = 0

beforeAll(() => {
  process.env['RESEND_API_KEY'] = 're_test'
  process.env['EMAIL_FROM'] = 'Acme <hello@acme.example.com>'

  globalThis.fetch = Object.assign(
    async () => {
      calls++
      return answers.shift() ?? Response.json({ id: 'email_1' })
    },
    { preconnect: () => {} },
  ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = saved.fetch

  for (const [name, value] of [
    ['RESEND_API_KEY', saved.key],
    ['EMAIL_FROM', saved.from],
  ] as const) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
})

const busy = () =>
  Response.json(
    { name: 'rate_limit_exceeded', message: 'Too many requests', statusCode: 429 },
    { status: 429 },
  )

const email = { to: 'sam@example.com', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' }

const send = (message: typeof email & { idempotencyKey?: string }) => {
  const rt = testRuntime(appLayer({ auth: Auth.layerTest([]) }))
  return rt.runPromise(Effect.result(Email.use((e) => e.send(message)))).finally(() => rt.dispose())
}

describe('Resend', () => {
  test('an email with an idempotency key is sent again after a rate limit, and goes', async () => {
    answers = [busy(), busy()]
    calls = 0
    const result = await send({ ...email, idempotencyKey: 'sequence-1-first' })
    expect(result).toMatchObject({ _tag: 'Success', success: { id: 'email_1', sent: true } })
    expect(calls).toBe(3)
  })

  test('an email without one is never sent twice: the failure is reported instead', async () => {
    answers = [busy()]
    calls = 0
    const result = await send(email)
    expect(result._tag).toBe('Failure')

    expect(result._tag === 'Failure' ? result.failure.message : '').toBe(
      'Resend: Too many requests',
    )

    expect(calls).toBe(1)
  })
})

describe("Resend's delivery webhook", () => {
  test('bounces and complaints name their addresses; anything else is no event', () => {
    expect(deliveryOf({ type: 'email.bounced', data: { to: ['a@b.test', 'c@d.test'] } })).toEqual({
      events: [{ kind: 'bounced', addresses: ['a@b.test', 'c@d.test'] }],
    })

    expect(deliveryOf({ type: 'email.complained', data: { to: 'a@b.test' } })).toEqual({
      events: [{ kind: 'complained', addresses: ['a@b.test'] }],
    })

    expect(deliveryOf({ type: 'email.delivered', data: { to: 'a@b.test' } })).toEqual({
      events: [],
    })

    expect(deliveryOf({ type: 'email.bounced', data: {} })).toEqual({ events: [] })
  })
})
