import { afterAll, describe, expect, spyOn, test } from 'bun:test'

import { Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'

import { FlashDrive, Ignored, StoreFolder } from '../../src/adapters/files/flashdrive/client'
import { guidesOffered } from '../../src/server/guides'
import { appLayer } from '../../src/server/runtime/app'
import { Auth } from '../../src/server/runtime/auth'
import { type Fetch, httpLayer } from '../../src/server/runtime/http'
import { testRuntime } from '../support/run'

// The file store's client: when it tries again, when it gives up, and what it
// makes of an answer it doesn't expect. A stand-in answers every request.

const saved = { ...process.env }
process.env['FLASHDRIVE_API_KEY'] = 'test-key'
process.env['FLASHDRIVE_DRIVE_ID'] = '6eb2d950-7a37-4e6d-a637-765600c2da62'
delete process.env['FLASHDRIVE_BASE_URL']

afterAll(() => {
  for (const name of ['FLASHDRIVE_API_KEY', 'FLASHDRIVE_DRIVE_ID', 'CRM_GUIDES']) {
    if (saved[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = saved[name]
    }
  }
})

const folder = { id: 'f1', name: 'Plans', parent_folder_id: null, etag: '"1"' }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A store that answers each request with the next of `answers` (the last one repeats), counting calls. */
function storeAnswering(...answers: (() => Response | Promise<Response>)[]) {
  const seen: { method: string; url: string; headers: Headers }[] = []

  const fetch: Fetch = async (url, init) => {
    seen.push({ method: init?.method ?? 'GET', url, headers: new Headers(init?.headers) })
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)]
    return answer ? answer() : json({})
  }

  const rt = testRuntime(FlashDrive.layer.pipe(Layer.provideMerge(httpLayer(fetch))))

  const call = <A, E>(program: (store: FlashDrive['Service']) => Effect.Effect<A, E>) =>
    rt
      .runPromise(Effect.flip(FlashDrive.use((store) => program(store))))
      .finally(() => rt.dispose())

  const ok = <A, E>(program: (store: FlashDrive['Service']) => Effect.Effect<A, E>) =>
    rt.runPromise(FlashDrive.use((store) => program(store))).finally(() => rt.dispose())

  return { seen, call, ok }
}

const quiet = () => spyOn(console, 'error').mockImplementation(() => {})

describe('trying again', () => {
  test('a read that meets a busy store is tried again, and succeeds', async () => {
    const store = storeAnswering(
      () => json({ error: { code: 'busy' } }, 503),
      () => json({ error: { code: 'busy' } }, 502),
      () => json(folder),
    )

    expect(await store.ok((s) => s.request('/v1/x/folders/f1', StoreFolder))).toEqual(folder)
    expect(store.seen.length).toBe(3)
  })

  test('a read is tried three times at most, then the teammate is told the store is busy', async () => {
    const store = storeAnswering(() => json({ error: { code: 'busy' } }, 503))
    const error = await store.call((s) => s.request('/v1/x/folders/f1', StoreFolder))
    expect(error.message).toBe('The file store is busy. Try again in a moment.')
    expect(store.seen.length).toBe(3)
  })

  test('a write without an idempotency key is never sent twice', async () => {
    const store = storeAnswering(() => json({ error: { code: 'busy' } }, 503))
    await store.call((s) => s.request('/v1/x/folders', Ignored, { body: { name: 'A' } }))
    expect(store.seen.length).toBe(1)
  })

  test('a write with an idempotency key is safe to repeat', async () => {
    const store = storeAnswering(
      () => json({}, 503),
      () => json(folder),
    )

    await store.ok((s) =>
      s.request('/v1/x/folders', StoreFolder, { body: { name: 'A' }, idempotencyKey: 'k' }),
    )

    expect(store.seen.map((c) => c.method)).toEqual(['POST', 'POST'])
  })

  test("a store that can't be reached says so, after trying again", async () => {
    const store = storeAnswering(() => {
      throw new TypeError('fetch failed')
    })

    const error = await store.call((s) => s.request('/v1/x/folders/f1', StoreFolder))
    expect(error).toMatchObject({ code: 'unreachable' })
    expect(error.message).toBe('The file store could not be reached. Try again in a moment.')
    expect(store.seen.length).toBe(3)
  })

  test("a refusal that won't change (404, 409) is not tried again", async () => {
    const store = storeAnswering(() => json({ error: { code: 'not_found' } }, 404))
    const error = await store.call((s) => s.request('/v1/x/folders/f1', StoreFolder))
    expect(error.message).toBe('That is no longer in the file store.')
    expect(store.seen.length).toBe(1)
  })
})

describe('relayed bytes', () => {
  test('reach the store with their length, and only once', async () => {
    const store = storeAnswering(() => json({}, 503))
    const bytes = new TextEncoder().encode('hello').buffer

    await store.call((s) =>
      s.request('/v1/x/uploads/u1/content', Ignored, {
        method: 'PUT',
        stream: { body: bytes, length: 5 },
      }),
    )

    expect(store.seen.length).toBe(1)
    expect(store.seen[0]?.headers.get('content-length')).toBe('5')
    expect(store.seen[0]?.headers.get('x-crm-content-length')).toBeNull()
  })
})

describe('answers', () => {
  test("an answer in a shape this code doesn't expect is an error naming the store, not a crash later", async () => {
    const log = quiet()
    const store = storeAnswering(() => json({ id: 7, name: null }))
    const error = await store.call((s) => s.request('/v1/x/folders/f1', StoreFolder))
    expect(error).toMatchObject({ code: 'unexpected_answer' })
    expect(error.message).toContain("The file store answered in a way this CRM doesn't understand")
    log.mockRestore()
  })

  test('a request the program stops waiting for is aborted, not left running', async () => {
    let aborted = false

    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      })

    // Effect's HTTP client, as the services use it; a time limit (or the browser going away) interrupts the call.
    const result = await Effect.runPromise(
      HttpClient.get('https://store.example/v1/x').pipe(
        Effect.timeout('50 millis'),
        Effect.exit,
        Effect.provide(httpLayer(hang)),
      ),
    )

    expect(result._tag).toBe('Failure')
    expect(aborted).toBe(true)
  })
})

test('configuration is read from the environment each time, as before Effect', async () => {
  const rt = testRuntime(appLayer({ auth: Auth.layerTest([]) }))
  process.env['CRM_GUIDES'] = 'off'
  expect(await rt.runPromise(guidesOffered)).toBe(false)
  process.env['CRM_GUIDES'] = 'on'
  expect(await rt.runPromise(guidesOffered)).toBe(true)
  await rt.dispose()
})
