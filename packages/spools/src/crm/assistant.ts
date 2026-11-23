/**
 * What the Ask page works out that is not React: how past chats are grouped and
 * titled, the prompts a new chat suggests, and what a reply's tool calls did and
 * which records they touched. Pure: no server or browser imports, so it is
 * tested on its own (tests/unit/assistant.test.ts). The page is
 * `src/routes/_crm/assistant.tsx`, its parts `src/crm/ui/assistant.tsx`.
 */
import { z } from 'zod'

export type ChatSession = { sessionId: string; title: string | null; updatedAt: string }

/** A prompt a new chat offers: `label` is the button, `prompt` is what is asked. */
export type Suggestion = { label: string; prompt: string }

type ObjectNames = Record<string, { label: string; labelPlural: string; titleField?: string }>

export type AssistantConfig = {
  objects: ObjectNames
  assistant?: { name?: string; greeting?: string; suggestions?: Suggestion[] } | undefined
}

export const assistantName = (config: AssistantConfig) => config.assistant?.name ?? 'Assistant'
export const assistantGreeting = (config: AssistantConfig) =>
  config.assistant?.greeting ?? 'What can I help with?'

/**
 * The prompts under the box of a new chat: the app's own (`assistant.suggestions`
 * in crm.config.json) or ones written from its first object, so they make sense
 * whatever the CRM holds.
 */
export function suggestionsFor(config: AssistantConfig): Suggestion[] {
  const own = config.assistant?.suggestions

  if (own && own.length > 0) {
    return own
  }

  const first = Object.values(config.objects)[0]
  const things = first ? first.labelPlural.toLowerCase() : 'records'
  return [
    { label: 'New this week', prompt: `Which ${things} were added this week?` },
    {
      label: 'Needs a follow-up',
      prompt: `Which ${things} have not been contacted in the last 30 days?`,
    },
    { label: 'Overdue tasks', prompt: `Which ${things} have a task that is overdue?` },
    { label: 'What can you do?', prompt: 'What can you help me with in this CRM?' },
  ]
}

/** How long a chat's title may be: it is one line in a narrow list. */
export const TITLE_MAX = 60

/** A chat is titled from its first message: one line, cut at a word. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()

  if (line.length <= TITLE_MAX) {
    return line
  }

  const cut = line.slice(0, TITLE_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[.,;:!?-]+$/, '')}…`
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const DAY = 86_400_000

/**
 * Chats under the headings a chat list is expected to have: Today, Yesterday,
 * Previous 7 days, Previous 30 days, then a month name for the rest of this
 * year and a year for anything older. Days are the reader's own calendar days.
 * Chats keep the order they came in (newest first), and so do the headings.
 */
export function groupByRecency<T extends { updatedAt: string }>(
  chats: T[],
  now: Date,
): { label: string; chats: T[] }[] {
  const today = startOfDay(now)
  const groups: { label: string; chats: T[] }[] = []

  for (const chat of chats) {
    const at = new Date(chat.updatedAt)
    // A calendar day is not always 24 hours long, so round rather than divide down.
    const daysAgo = Math.round((today - startOfDay(at)) / DAY)

    const label =
      daysAgo <= 0
        ? 'Today'
        : daysAgo === 1
          ? 'Yesterday'
          : daysAgo <= 7
            ? 'Previous 7 days'
            : daysAgo <= 30
              ? 'Previous 30 days'
              : at.getFullYear() === now.getFullYear()
                ? at.toLocaleString('en', { month: 'long' })
                : String(at.getFullYear())

    const group = groups.find((g) => g.label === label)

    if (group) {
      group.chats.push(chat)
    } else {
      groups.push({ label, chats: [chat] })
    }
  }

  return groups
}

/** Chats whose title has every word that was typed, in any order. */
export function matchChats<T extends { title: string }>(chats: T[], typed: string): T[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return chats
  }

  return chats.filter((c) => {
    const title = c.title.toLowerCase()
    return words.every((w) => title.includes(w))
  })
}

// ---------------------------------------------------------------------------
// Tool calls. A reply's parts follow the AI SDK's UI message shape: text parts,
// and one part per tool call (`tool-<name>` or `dynamic-tool`) that moves from
// input to output. Nothing here trusts that shape further than it has to: each
// field is read with Zod as it is used.
// ---------------------------------------------------------------------------

/**
 * One part of a message, with the fields read here. A tool's input and output
 * are whatever the tool sent, and a stored chat may hold anything at all, so
 * none of them is taken on trust.
 */
export type MessagePart = {
  type: string
  text?: unknown
  toolName?: unknown
  state?: unknown
  errorText?: unknown
  input?: unknown
  args?: unknown
  output?: unknown
  result?: unknown
}

export const isToolPart = (part: { type: string }) =>
  part.type.startsWith('tool-') || part.type === 'dynamic-tool'

/** A string, or undefined for anything else. */
const optionalText = z.string().optional().catch(undefined)

/** A tool's input or output may arrive as JSON text: text that holds JSON is read as that JSON. */
const decoded = z.union([
  z.string().transform((text) => {
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch {
      return text
    }
  }),
  z.unknown(),
])

/** Any object that isn't a list, with what it holds. */
const objectInput = z.looseObject({})

/** The parts of a tool's input that name what it worked on. */
const toolInput = z
  .object({ objectKey: optionalText, query: optionalText, id: optionalText })
  .catch({})

type ToolInput = z.output<typeof toolInput>

/** The tool a part called, without the `crm_` every CRM tool starts with: "search", "add_note". */
export function toolOf(part: MessagePart): string {
  const name = optionalText.parse(part.toolName) ?? part.type.replace(/^tool-/, '')
  return name.replace(/^crm_/, '')
}

const inputOf = (part: MessagePart): ToolInput =>
  toolInput.parse(decoded.parse(part.input ?? part.args))

const outputOf = (part: MessagePart) => decoded.parse(part.output ?? part.result)

/**
 * The tool API answers `{ ok: false, error }` with HTTP 200 so the model can read
 * the message; to a person that is still a step that failed. Looks a few levels
 * down, since the workflow that made the call may wrap what it returns, and
 * reports the first refusal it meets, reading in order and depth first.
 */
function refusal(part: MessagePart): string | null {
  const pending = [{ value: outputOf(part), depth: 0 }]

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const node = objectInput.safeParse(decoded.parse(next.value))

    if (!node.success || next.depth > 3) {
      continue
    }

    const { ok, error } = node.data

    if (ok === false) {
      // An empty message says nothing: the search goes on past it.
      const message = optionalText.parse(error) ?? 'It did not work'

      if (message) {
        return message
      }

      continue
    }

    if (ok === true) {
      continue
    }

    // Last in, first out: the first value is the next one looked at.
    for (const value of Object.values(node.data).toReversed()) {
      pending.push({ value, depth: next.depth + 1 })
    }
  }

  return null
}

export type ToolStep = {
  /** "Searched deals", "Searching deals", "Could not search deals". */
  label: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  /** Why it failed, when the tool said. */
  detail?: string
}

/** The three ways each tool is named: while it runs, once done, and in "Could not ...". */
function wording(tool: string, input: ToolInput, objects: ObjectNames): [string, string, string] {
  const key = input.objectKey ?? ''
  const obj = Object.hasOwn(objects, key) ? objects[key] : undefined
  const one = obj ? obj.label.toLowerCase() : 'record'
  const many = obj ? obj.labelPlural.toLowerCase() : 'records'
  const a = /^[aeiou]/.test(one) ? 'an' : 'a'
  const asked = input.query?.trim()
  const query = asked ? ` for “${asked}”` : ''

  switch (tool) {
    case 'describe':
      return [
        'Checking how the CRM is set up',
        'Checked how the CRM is set up',
        'check how the CRM is set up',
      ]
    case 'search':
      return [`Searching ${many}${query}`, `Searched ${many}${query}`, `search ${many}`]
    case 'get':
      return [`Reading ${a} ${one}`, `Read ${a} ${one}`, `read the ${one}`]
    case 'create':
      return [`Creating ${a} ${one}`, `Created ${a} ${one}`, `create the ${one}`]
    case 'update':
      return [`Updating ${a} ${one}`, `Updated ${a} ${one}`, `update the ${one}`]
    case 'add_note':
      return [`Adding a note to ${a} ${one}`, `Added a note to ${a} ${one}`, 'add the note']

    default: {
      const plain = tool.replace(/_/g, ' ')
      return [`Running ${plain}`, `Used ${plain}`, `run ${plain}`]
    }
  }
}

/**
 * What one tool call is doing, in the reader's words. `live` is whether the
 * reply is still arriving: a call left unfinished in a reply that has ended was
 * stopped, not still running.
 */
export function toolStep(part: MessagePart, objects: ObjectNames, live: boolean): ToolStep {
  const [doing, did, verb] = wording(toolOf(part), inputOf(part), objects)
  const state = part.state

  if (state === 'output-error') {
    const failed: ToolStep = { label: `Could not ${verb}`, status: 'failed' }
    const detail = optionalText.parse(part.errorText)

    if (detail) {
      failed.detail = detail
    }

    return failed
  }

  if (state === 'output-available') {
    const refused = refusal(part)
    return refused
      ? { label: `Could not ${verb}`, status: 'failed', detail: refused }
      : { label: did, status: 'done' }
  }

  return live ? { label: doing, status: 'running' } : { label: doing, status: 'stopped' }
}

/** One line for a run of tool calls: the step itself when there is one, a count when there are several. */
export function stepsSummary(steps: ToolStep[]): string {
  const running = steps.findLast((s) => s.status === 'running')

  if (running) {
    return running.label
  }

  if (steps.length === 1) {
    return steps[0]?.label ?? ''
  }

  const failed = steps.filter((s) => s.status === 'failed').length
  return failed > 0 ? `Took ${steps.length} steps, ${failed} failed` : `Took ${steps.length} steps`
}

// ---------------------------------------------------------------------------
// Records a reply drew on, shown under it as links into the CRM.
// ---------------------------------------------------------------------------

export type RecordRef = { objectKey: string; id: string; title: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A record's title: text, or a number such as an invoice's. */
const titleInput = z.union([z.string(), z.number()])

/**
 * Records anywhere in a tool's output: objects with an id and this object's
 * title field, in the order they are met reading depth first, at most 50.
 */
function recordsIn(part: MessagePart, titleField: string) {
  const found: { id: string; title: string }[] = []
  const pending = [{ value: outputOf(part), depth: 0 }]

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (found.length >= 50) {
      break
    }

    if (next.depth > 5) {
      continue
    }

    const value = decoded.parse(next.value)
    let inner: unknown[] = []

    if (Array.isArray(value)) {
      inner = value
    } else {
      const node = objectInput.safeParse(value)

      if (!node.success) {
        continue
      }

      const id = optionalText.parse(node.data['id'])
      const title = titleInput.safeParse(node.data[titleField])

      if (id !== undefined && UUID.test(id) && title.success) {
        found.push({ id, title: String(title.data) })
        // A record's own relations are other objects' records: not this one's to name.
        continue
      }

      inner = Object.values(node.data)
    }

    // Last in, first out: the first value is the next one looked at.
    for (const item of inner.toReversed()) {
      pending.push({ value: item, depth: next.depth + 1 })
    }
  }

  return found
}

/** The most records one reply lists: a search returns up to 25, and a reply may search a few times. */
export const SOURCES_MAX = 40

/**
 * The records a reply's tool calls read or changed, each once, in the order they
 * were first seen. A record only ever comes from a call that named a real object,
 * and its id from the tool's own output or input, so a link can't be made up by
 * the text of a reply.
 */
export function recordsFrom(parts: MessagePart[], objects: ObjectNames): RecordRef[] {
  const seen = new Map<string, RecordRef>()

  const add = (ref: RecordRef) => {
    const key = `${ref.objectKey}:${ref.id}`
    const had = seen.get(key)

    if (!had) {
      seen.set(key, ref)
    } else if (!had.title && ref.title) {
      had.title = ref.title
    }
  }

  for (const part of parts) {
    if (!isToolPart(part) || part.state !== 'output-available') {
      continue
    }

    const tool = toolOf(part)

    if (tool === 'describe') {
      continue
    }

    const input = inputOf(part)
    const objectKey = input.objectKey ?? ''

    if (!Object.hasOwn(objects, objectKey)) {
      continue
    }

    if (refusal(part)) {
      continue
    }

    const titleField = objects[objectKey]?.titleField
    // A note has a title too, and it is not the record's: for a note, only the record asked about counts.
    const found = tool === 'add_note' || !titleField ? [] : recordsIn(part, titleField)

    for (const r of found) {
      add({ objectKey, id: r.id, title: r.title })
    }

    const asked = input.id

    if (asked !== undefined && UUID.test(asked) && !found.some((r) => r.id === asked)) {
      add({ objectKey, id: asked, title: null })
    }

    if (seen.size >= SOURCES_MAX) {
      break
    }
  }

  return [...seen.values()].slice(0, SOURCES_MAX)
}

/** A reply's words, for the copy button: its text parts, without the tool calls between them. */
export function textOf(parts: MessagePart[]): string {
  return parts
    .flatMap((p) => (p.type === 'text' ? (optionalText.parse(p.text) ?? []) : []))
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Whether a message has anything to show: words or a tool call. */
export const hasContent = (parts: MessagePart[]) =>
  parts.some((p) => (p.type === 'text' && !!optionalText.parse(p.text)?.trim()) || isToolPart(p))
