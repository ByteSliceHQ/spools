import { expect, test } from 'bun:test'

import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { Email, makeStore, sqlBackend, Store } from '@swirls/spools/adapter'

import { postmark } from './postmark'

// An adapter may keep things in the Spool's database. This one doesn't.
const store = Layer.succeed(
  Store,
  Store.of(
    makeStore(
      sqlBackend(
        () => Effect.succeed([]),
        (program) => program,
      ),
    ),
  ),
)

const email = { to: 'ada@example.com', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' }

/** Sends the email with Postmark answering with this status, and says what it was asked. */
async function send(status: number, env: Record<string, string>) {
  const asked: { url: string; token: string | undefined }[] = []

  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      asked.push({ url: request.url, token: request.headers['x-postmark-server-token'] })

      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{}', { status })))
    }),
  )

  const runtime = ManagedRuntime.make(
    postmark().layer.pipe(
      Layer.provide([http, store]),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  )

  const exit = await runtime.runPromiseExit(Email.use((service) => service.send(email)))
  await runtime.dispose()
  return { exit, asked }
}

const env = { POSTMARK_TOKEN: 'token', EMAIL_FROM: 'crm@example.com' }

test('sends through Postmark', async () => {
  const { exit, asked } = await send(200, env)
  expect(exit).toEqual(Exit.succeed({ id: null, sent: true }))
  expect(asked).toEqual([{ url: 'https://api.postmarkapp.com/email', token: 'token' }])
})

test('says so when Postmark refuses', async () => {
  const { exit } = await send(422, env)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(JSON.stringify(exit)).toContain('Postmark refused the email (422)')
})

test('sends nothing until it is set up', async () => {
  const { exit, asked } = await send(200, {})
  expect(exit).toEqual(Exit.succeed({ id: null, sent: false }))
  expect(asked).toEqual([])
})
