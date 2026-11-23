/**
 * Stand-in for the agent engine (e2e only), so the Ask page can be tried without
 * a Swirls project. e2e/spool.server.ts uses it when `E2E_ASSISTANT=stub`; the
 * app's own build never imports it.
 *
 * Chats live in this process's memory and are gone when the server restarts.
 * Replies are canned, but they arrive the way real ones do: a pause, tool
 * calls, then words a few at a time. The search step is a real one against the
 * local database, so the records a reply links to exist. Nothing is ever
 * written. What to type:
 *
 *   anything          a describe and a search step, then a short answer with a list
 *   "table", "markdown"   headings, a table, a code block and links
 *   "long"            a long answer, to try scrolling and Stop
 *   "image"           Markdown with an image in it, which the page must show as a link
 *   "note", "update"  a step that fails (the stub never changes records)
 *   "error"           the request itself fails
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageStreamWriter,
  validateUIMessages,
} from 'ai'
import { Effect, Layer } from 'effect'
import { z } from 'zod'

import {
  Agents,
  type AgentsAdapter,
  type AssistantChat,
  CHATS_LISTED,
  titleFrom,
} from '@swirls/spools/adapter'
import { runServer } from '@swirls/spools/server/runtime'
import { crmConfig } from '@swirls/spools/server/spool'
import { runTool } from '@swirls/spools/server/tools'

type Session = { title: string | null; updatedAt: Date; messages: UIMessage[] }

// Kept on globalThis so Vite reloading this module after an edit doesn't forget the chats.
// Only this module writes under its key.
const sessionsKey = Symbol.for('spools.e2e.assistantStub')
const store: typeof globalThis & { [sessionsKey]?: Map<string, Session> } = globalThis
const seeded = !!store[sessionsKey]
store[sessionsKey] ??= new Map<string, Session>()
const sessions = store[sessionsKey]
const DAY = 86_400_000

const said = (role: 'user' | 'assistant', text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role,
  parts: [{ type: 'text', text }],
})

// A few past chats, so the list has every heading to show.
if (!seeded) {
  for (const [daysAgo, question, answer] of [
    [
      0,
      'Which deals are closest to closing?',
      'Three deals are in negotiation. The largest is worth $48,000.',
    ],
    [
      1,
      'Summarize the newest leads from the website',
      'Five new leads came in this week. Two asked for a quote.',
    ],
    [
      4,
      'Who have we not contacted in a month?',
      'Eight contacts have had no contact in the last 30 days.',
    ],
    [
      6,
      'Draft a follow-up for the Henderson quote',
      'Here is a short follow-up you can send:\n\n> Hi, just checking in.',
    ],
    [
      19,
      'How many deals did we win last quarter?',
      'Twelve deals were won last quarter, worth $310,000 together.',
    ],
    [
      64,
      'What does the pipeline look like by stage?',
      '| Stage | Deals |\n| --- | --- |\n| Lead | 14 |\n| Won | 12 |',
    ],
    [
      400,
      'Explain how tasks and notes work',
      'Tasks have a due date and an owner. Notes are free text on a record.',
    ],
  ] as const) {
    sessions.set(crypto.randomUUID(), {
      title: titleFrom(question),
      updatedAt: new Date(Date.now() - daysAgo * DAY - 60_000),
      messages: [said('user', question), said('assistant', answer)],
    })
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const textIn = (m: UIMessage | undefined) =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ')

/** Words a few at a time, like a model's tokens. */
async function write(writer: UIMessageStreamWriter, text: string, pause = 28) {
  const id = crypto.randomUUID()
  writer.write({ type: 'text-start', id })

  for (const piece of text.match(/\S+\s*/g) ?? []) {
    writer.write({ type: 'text-delta', id, delta: piece })
    await wait(pause)
  }

  writer.write({ type: 'text-end', id })
}

/** What a tool step is called with here: a few plain values. */
type ToolInput = Record<string, string | number>

async function tool<Output>(
  writer: UIMessageStreamWriter,
  toolName: string,
  input: ToolInput,
  run: () => Promise<Output>,
): Promise<Output> {
  const toolCallId = crypto.randomUUID()
  writer.write({ type: 'tool-input-start', toolCallId, toolName })
  writer.write({ type: 'tool-input-available', toolCallId, toolName, input })
  await wait(700)
  const output = await run()
  writer.write({ type: 'tool-output-available', toolCallId, output })
  return output
}

const FORMATTING = `## What a reply can hold

Replies are **Markdown**. A list:

1. Numbered steps
2. With \`inline code\`
   - and nested points

### A table

| Stage | Deals | Value |
| --- | ---: | ---: |
| Lead | 14 | $92,000 |
| Negotiation | 3 | $61,500 |
| Won | 12 | $310,000 |

### A code block

\`\`\`json
{ "field": "value", "op": "gt", "value": 5000 }
\`\`\`

> A quotation, and a link to [the docs](https://swirls.ai/docs).
`

const LONG = Array.from(
  { length: 14 },
  (_, i) =>
    `**Point ${i + 1}.** This paragraph is here to make the answer long enough to scroll, so following the reply, scrolling away from it and the button that comes back to the end can all be tried. Stop it part way to see where it halts.`,
).join('\n\n')

/** The records a search step found; a reply that can't be read as rows lists none. */
const foundRows = z.array(z.record(z.string(), z.unknown())).catch([])
/** A row's title, as the reply lists it. */
const titleText = z.union([z.string(), z.number()]).catch('Untitled')

// A reply must never make the browser fetch from another server: e2e/tests/assistant.e2e.ts.
const IMAGE = `Here is the chart.

![chart](https://example.com/a.png)

The page shows an image as a link, so nothing is fetched until someone follows it.
`

async function reply(writer: UIMessageStreamWriter, question: string, again: boolean) {
  const q = question.toLowerCase()
  writer.write({ type: 'start' })
  writer.write({ type: 'start-step' })
  await wait(900)
  const opening = again ? 'Here is another take. ' : ''

  if (/\b(table|markdown|format)/.test(q)) {
    await write(writer, opening + FORMATTING)
  } else if (/\blong\b/.test(q)) {
    await write(writer, opening + LONG, 18)
  } else if (/\bimage\b/.test(q)) {
    await write(writer, opening + IMAGE)
  } else {
    const keys = Object.keys(crmConfig().objects)

    const objectKey =
      keys.find((k) => {
        const o = crmConfig().objects[k]
        return o && (q.includes(o.labelPlural.toLowerCase()) || q.includes(o.label.toLowerCase()))
      }) ??
      keys[0] ??
      ''

    const obj = crmConfig().objects[objectKey]
    await tool(writer, 'crm_describe', {}, () => runServer(runTool('describe', {})))

    const found = await tool(writer, 'crm_search', { objectKey, limit: 5 }, () =>
      runServer(runTool('search', { objectKey, limit: 5 })),
    )

    if (/\b(note|update|change)/.test(q)) {
      await tool(
        writer,
        'crm_add_note',
        { objectKey, id: '00000000-0000-4000-8000-000000000000', body: '…' },
        async () => ({ ok: false, error: 'The stub never changes records.' }),
      )
    }

    const rows = found.ok ? foundRows.parse(found.data) : []
    const titles = rows.map((r) => String(titleText.parse(r[obj?.titleField ?? 'id'])))

    const many = obj?.labelPlural.toLowerCase() ?? 'records'

    await write(
      writer,
      titles.length > 0
        ? `${opening}This is a canned reply from the local stub, not the real assistant. ${titles.length === 1 ? `The one ${obj?.label.toLowerCase() ?? 'record'}` : `The first ${titles.length} ${many}`} it found:\n\n${titles.map((t) => `- **${t}**`).join('\n')}\n\nAsk for a *table*, something *long*, a *note* or an *error* to see the other kinds of reply.`
        : `${opening}This is a canned reply from the local stub. It found no ${many} in the local database.`,
    )
  }

  writer.write({ type: 'finish-step' })
  writer.write({ type: 'finish' })
}

/** What the chat page posts for a turn. */
const sendBody = z.object({
  id: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
  trigger: z.string().optional(),
})

// Read when the layer is built, never inlined by a bundler: the guard is about where the build runs.
const runtimeEnv = (name: string): string | undefined => process.env[name]

const chat: AssistantChat = {
  async listSessions(options) {
    return [...sessions.entries()]
      .map(([sessionId, s]) => ({ sessionId, title: s.title, updatedAt: s.updatedAt }))
      .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, options?.limit ?? CHATS_LISTED)
  },
  async createSession(options) {
    const sessionId = crypto.randomUUID()
    sessions.set(sessionId, { title: options?.title ?? null, updatedAt: new Date(), messages: [] })
    return { sessionId }
  },
  async getMessages(sessionId) {
    return { messages: sessions.get(sessionId)?.messages ?? [] }
  },
  async forwardSend(request) {
    const body = sendBody.parse(await request.json())
    const session = body.id ? sessions.get(body.id) : undefined

    if (!session) {
      return Response.json({ error: 'No such chat' }, { status: 404 })
    }

    const again = body.trigger === 'regenerate-message'

    // Checked like the real channel would: the browser sends the whole chat.
    const messages = body.messages?.length
      ? await validateUIMessages({ messages: body.messages })
      : []

    const asked = messages.findLast((m) => m.role === 'user')
    const question = textIn(asked)

    if (/\berror\b/i.test(question)) {
      return Response.json(
        { error: 'The stub was asked to fail. Send anything else to carry on.' },
        { status: 500 },
      )
    }

    if (again) {
      // A second answer takes the place of the first.
      if (session.messages.at(-1)?.role === 'assistant') {
        session.messages.pop()
      }
    } else if (asked) {
      session.messages.push(asked)
    }

    session.title ??= titleFrom(question)
    session.updatedAt = new Date()

    const stream = createUIMessageStream({
      execute: ({ writer }) => reply(writer, question, again),
      onFinish: ({ responseMessage }) => {
        session.messages.push(responseMessage)
        session.updatedAt = new Date()
      },
    })

    // Like the real channel, the turn runs to its end whether or not the browser is still reading.
    const [toBrowser, toEnd] = stream.tee()

    void (async () => {
      const reader = toEnd.getReader()
      while (!(await reader.read()).done) {}
    })()

    return createUIMessageStreamResponse({ stream: toBrowser })
  },
  regenerate: true,
  async forwardResumeStream() {
    return new Response(null, { status: 204 })
  },
  async deleteSession(sessionId) {
    return sessions.delete(sessionId)
  },
}

/** An engine with no workflows and a canned assistant. */
export const stubAgents = (): AgentsAdapter => ({
  id: 'stub',
  label: 'The assistant stub',
  layer: Layer.sync(Agents, () => {
    // The same guard as the development sign-in: a build that has this in it must never run as the real thing.
    if (runtimeEnv('NODE_ENV') === 'production') {
      throw new Error(
        'This build has the assistant stubbed out (E2E_ASSISTANT=stub). Run `bun run build` instead.',
      )
    }

    return Agents.of({
      configured: Effect.succeed(true),
      executeWorkflow: () =>
        Effect.succeed({ skipped: true, reason: 'the assistant stub runs no workflows' }),
      chat: Effect.succeed(chat),
    })
  }),
})
