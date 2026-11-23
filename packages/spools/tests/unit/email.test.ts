import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import type { Effect } from 'effect'

import { durationMs } from '../../src/server/campaigns'
import {
  renderTemplate,
  textToHtml,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from '../../src/server/email'
import { type AppServices, appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { testRuntime } from '../support/run'

const rt = testRuntime(appLayer({ auth: Auth.layerTest([]) }))
const run = <A, E>(program: Effect.Effect<A, E, AppServices>) => rt.runPromise(program)
afterAll(() => rt.dispose())

beforeAll(() => {
  process.env['APP_SECRET'] = 's'.repeat(40)
  process.env['APP_URL'] = 'https://crm.example.com/'
})

describe('templates', () => {
  test('replaces placeholders and blanks missing values', () => {
    expect(renderTemplate('Hi {{name}}, {{ missing }}!', { name: 'Ada' })).toBe('Hi Ada, !')
  })

  test("a placeholder named like a built-in is a missing value, not the built-in's text", () => {
    expect(renderTemplate('[{{constructor}}][{{toString}}]', { name: 'Ada' })).toBe('[][]')
  })

  test('HTML output escapes values', () => {
    const html = textToHtml(renderTemplate('Hi {{name}}\n\nBye', { name: '<script>x</script>' }))
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html.match(/<p /g)?.length).toBe(2)
  })
})

describe('unsubscribe tokens', () => {
  test('round-trip, case-insensitive address', async () => {
    expect(await run(verifyUnsubscribeToken(await run(unsubscribeToken('Ada@Example.com'))))).toBe(
      'ada@example.com',
    )
  })

  test('reject tampered tokens', async () => {
    const [payload, sig] = (await run(unsubscribeToken('ada@example.com'))).split('.')
    const forged = `${Buffer.from('eve@example.com').toString('base64url')}.${sig}`
    expect(await run(verifyUnsubscribeToken(forged))).toBeNull()
    expect(await run(verifyUnsubscribeToken(`${payload}.AAAA`))).toBeNull()
    expect(await run(verifyUnsubscribeToken('garbage'))).toBeNull()
  })

  test('URL uses APP_URL without a double slash', async () => {
    expect(await run(unsubscribeUrl('a@b.co'))).toStartWith(
      'https://crm.example.com/unsubscribe?t=',
    )
  })

  test('there is no link without APP_URL, so no campaign email with a dead one', async () => {
    const url = process.env['APP_URL']
    delete process.env['APP_URL']
    await expect(run(unsubscribeUrl('a@b.co'))).rejects.toThrow('APP_URL')
    process.env['APP_URL'] = url
  })

  test('refuses to sign without a strong secret', async () => {
    process.env['APP_SECRET'] = 'short'
    await expect(run(unsubscribeToken('a@b.co'))).rejects.toThrow('APP_SECRET')
    process.env['APP_SECRET'] = 's'.repeat(40)
  })
})

test('durations', () => {
  expect(durationMs('0m')).toBe(0)
  expect(durationMs('90m')).toBe(5_400_000)
  expect(durationMs('2h')).toBe(7_200_000)
  expect(durationMs('3d')).toBe(259_200_000)
  expect(() => durationMs('3w')).toThrow()
})
