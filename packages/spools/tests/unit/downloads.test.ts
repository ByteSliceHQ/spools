import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import { fileHandlers } from '../../src/api/file'
import { fileResponse, servedAs } from '../../src/server/downloads'
import { FilesError } from '../../src/server/runtime/errors'
import { FileStore, type OpenedFile } from '../../src/server/runtime/files'
import { installLiveServices, installStandIns } from '../support/run'

// Files people uploaded, handed to a browser on the CRM's own origin: nothing
// anyone uploads may run there with the session of whoever opens it.

const body = (text: string) => {
  const { body } = new Response(text)

  if (!body) {
    throw new Error('No body')
  }

  return body
}

const opened = (name: string, text = '<script>alert(1)</script>') =>
  fileResponse({ kind: 'bytes', body: body(text), name, sizeBytes: text.length })

const ALWAYS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, no-store',
}

describe('a file served from this origin', () => {
  test("is shown only when it is of a type that can't run, by its extension", () => {
    const shown = {
      'a.png': 'image/png',
      'a.JPG': 'image/jpeg',
      'b.jpeg': 'image/jpeg',
      'c.gif': 'image/gif',
    }

    for (const [name, type] of Object.entries({
      ...shown,
      'd.webp': 'image/webp',
      'Quote v2.PDF': 'application/pdf',
    })) {
      const { headers } = opened(name)
      expect(headers.get('content-type')).toBe(type)
      expect(headers.get('content-disposition')).toStartWith('inline; ')
    }
  })

  test('is otherwise downloaded as plain bytes: pages, scripts and drawings that can hold scripts above all', () => {
    for (const name of [
      'page.html',
      'page.HTM',
      'page.xhtml',
      'drawing.svg',
      'drawing.SVG',
      'drawing.svgz',
      'feed.xml',
      'script.js',
      'script.mjs',
      'style.css',
      'page.mhtml',
      'page.pdf.html',
      'page.png.svg',
      'page.png ',
      'png',
      'README',
      '.png.html',
      'archive.tar.gz',
      'a.constructor',
      'a.__proto__',
      'a.toString',
      '',
    ]) {
      const { headers } = opened(name)
      expect([name, headers.get('content-type')]).toEqual([name, 'application/octet-stream'])
      expect(headers.get('content-disposition')).toStartWith('attachment; ')
    }
  })

  test('always says not to guess its type, not to run it and not to keep it', () => {
    for (const name of ['a.png', 'page.html', 'drawing.svg', 'quote.pdf']) {
      expect(Object.fromEntries(opened(name).headers)).toMatchObject(ALWAYS)
    }
  })

  test('carries its name whatever is in it, and nothing in a name becomes a header', () => {
    const disposition = (name: string) => servedAs(name).disposition

    expect(disposition('Küchenplan (final).docx')).toBe(
      'attachment; filename="K_chenplan (final).docx"; filename*=UTF-8\'\'K%C3%BCchenplan%20%28final%29.docx',
    )

    expect(disposition('報價.pdf')).toBe(
      'inline; filename="__.pdf"; filename*=UTF-8\'\'%E5%A0%B1%E5%83%B9.pdf',
    )

    expect(disposition(`it's 100% "done" * \\.txt`)).toBe(
      "attachment; filename=\"it's 100_ _done_ * _.txt\"; filename*=UTF-8''it%27s%20100%25%20%22done%22%20%2A%20%5C.txt",
    )

    for (const name of [
      'a\r\nset-cookie: b=c\r\n.txt',
      'a\0b.txt',
      'a\u{1F4C4}.txt',
      'lone \ud800 half.txt',
    ]) {
      const headers = opened(name).headers

      expect(headers.get('content-disposition')).toMatch(
        /^attachment; filename="[ -~]*"; filename\*=UTF-8''[!#$&+.^`|~\w%-]*$/,
      )

      expect(headers.get('set-cookie')).toBeNull()
    }
  })

  test('has its length when it is known', async () => {
    const response = opened('a.txt', '12345')
    expect(response.headers.get('content-length')).toBe('5')
    expect(await response.text()).toBe('12345')
    const unknown = fileResponse({ kind: 'bytes', body: body('x'), name: 'a.txt', sizeBytes: null })
    expect(unknown.headers.get('content-length')).toBeNull()
  })
})

describe('opening a file', () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
  const asked: string[] = []

  const answers: Record<string, Effect.Effect<OpenedFile, FilesError>> = {
    [id(1)]: Effect.succeed({ kind: 'link', url: 'https://storage.example/get/1?signature=abc' }),
    [id(2)]: Effect.sync(() => ({
      kind: 'bytes',
      body: body('<svg onload=alert(1)>'),
      name: 'logo.svg',
      sizeBytes: 21,
    })),
    [id(3)]: Effect.fail(
      new FilesError({ message: 'That is no longer in the file store.', status: 404 }),
    ),
    [id(4)]: Effect.fail(
      new FilesError({ message: 'The file store is busy. Try again in a moment.', status: 503 }),
    ),
  }

  const files = Layer.effect(
    FileStore,
    Effect.map(FileStore, (none) =>
      FileStore.of({
        ...none,
        open: (file) => {
          asked.push(file)
          return answers[file] ?? Effect.die(new Error('not asked for'))
        },
      }),
    ),
  ).pipe(Layer.provide(FileStore.none))

  const get = (file: string) =>
    fileHandlers.GET({
      request: new Request(`http://localhost/api/files/${file}`),
      params: { id: file },
    })

  beforeAll(() => installStandIns({ files }))
  afterAll(() => installLiveServices())

  test("a store that signs links has the browser sent to one, which isn't remembered or passed on", async () => {
    const response = await get(id(1))
    expect(response.status).toBe(302)

    expect(Object.fromEntries(response.headers)).toEqual({
      location: 'https://storage.example/get/1?signature=abc',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
  })

  test("a store that doesn't has the bytes passed on, safely", async () => {
    const response = await get(id(2))
    expect(response.status).toBe(200)

    expect(Object.fromEntries(response.headers)).toEqual({
      ...ALWAYS,
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="logo.svg"; filename*=UTF-8\'\'logo.svg',
      'content-length': '21',
    })

    expect(await response.text()).toBe('<svg onload=alert(1)>')
  })

  test("one that is gone, or a store that can't be used, is said in words", async () => {
    const gone = await get(id(3))
    expect([gone.status, await gone.text()]).toEqual([404, 'That is no longer in the file store.'])
    const busy = await get(id(4))

    expect([busy.status, await busy.text()]).toEqual([
      502,
      'The file store is busy. Try again in a moment.',
    ])
  })

  test("an id that isn't one is never asked for, and neither is anything for someone signed out", async () => {
    asked.length = 0
    expect((await get('..%2f..%2fetc%2fpasswd')).status).toBe(404)
    process.env['DEV_AUTH_SIGNED_OUT'] = '1'
    const response = await get(id(2))
    delete process.env['DEV_AUTH_SIGNED_OUT']
    expect([response.status, response.headers.get('location')]).toEqual([302, '/sign-in'])
    expect(asked).toEqual([])
  })
})
