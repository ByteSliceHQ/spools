/**
 * Search over what the browser already holds: every record's title and
 * searchable fields, matched and ranked as each key is pressed, with no
 * request. Pure and shared: no server imports, so it can be tested on its own.
 * The server builds the index in `src/server/search.ts`; the palette that uses
 * it is `src/crm/ui/search.tsx`.
 */

/** One record: id, title, a line that tells it from others of the same name, then one value per indexed field. */
export type IndexRow = [id: string, title: string, summary: string, ...values: (string | null)[]]

export type IndexObject = {
  /** The fields the values after the summary belong to, in order. */
  fields: string[]
  /** Most recently changed first. */
  rows: IndexRow[]
  /** How many records the object has. More than `rows` when the object is larger than the index holds. */
  total: number
}

/** A note's id and title, and the record it is attached to (if any). */
export type NoteRow = [id: string, title: string, objectKey: string | null, recordId: string | null]

export type QuickIndex = {
  /** When the server read it; sent back to ask only for what changed since. */
  at: string
  objects: Record<string, IndexObject>
  notes: { rows: NoteRow[]; total: number }
  /** Views made in the app (config views are already in the page), so search can jump to one by name. */
  views: { id: string; label: string; objectKey: string }[]
  /**
   * Which record scopes it was read for (`scopeKey` in scopes.ts), in a Spool
   * that has them. An index read for one is never merged into, or shown in
   * place of, an index read for another. Not sent yet.
   */
  scope?: string
}

/** The largest number of records of one object the browser is given. */
export const INDEX_LIMIT = 25_000

// ── Text ────────────────────────────────────────────────────────────────────

/**
 * Lower-case, accents removed, one character out for each one in: positions in
 * the folded text are positions in the original, which highlighting relies on.
 */
export function fold(text: string): string {
  let out = ''

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    const code = ch.charCodeAt(0)

    if (code < 128) {
      out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch
    } else {
      const base = ch.normalize('NFD').charAt(0).toLowerCase()
      out += base.length === 1 ? base : ch
    }
  }

  return out
}

/** What was typed, as words to look for. */
export const terms = (q: string): string[] => fold(q).split(/\s+/).filter(Boolean)

const digitsOf = (text: string) => text.replace(/\D/g, '')

/** Typed text that reads as (part of) a phone number: digits and the punctuation people put between them. */
export const phoneDigits = (term: string): string | undefined => {
  const digits = digitsOf(term)
  return digits.length >= 3 && /^[\d\s().+-]+$/.test(term) ? digits : undefined
}

/** Equal, or one letter wrong, missing, extra, or two neighbours swapped. */
export function near(a: string, b: string): boolean {
  if (a === b) {
    return true
  }

  const la = a.length
  const lb = b.length

  if (Math.abs(la - lb) > 1) {
    return false
  }

  let i = 0

  while (i < la && i < lb && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++
  }

  if (la === lb) {
    // One letter replaced, or this one and the next swapped.
    if (a.slice(i + 1) === b.slice(i + 1)) {
      return true
    }

    return (
      a.charAt(i) === b.charAt(i + 1) &&
      a.charAt(i + 1) === b.charAt(i) &&
      a.slice(i + 2) === b.slice(i + 2)
    )
  }

  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/**
 * A typed word against the start of a word in a title, forgiving one slip.
 * Short words must be exact, and so must anything with a digit in it: a
 * reference or house number that is one digit off is a different one.
 */
function nearPrefix(term: string, word: string): boolean {
  if (term.length < 4 || /\d/.test(term) || term.charCodeAt(0) !== word.charCodeAt(0)) {
    return false
  }

  const n = term.length
  return (
    near(term, word.slice(0, n)) ||
    near(term, word.slice(0, n + 1)) ||
    near(term, word.slice(0, n - 1))
  )
}

/** Where a match stands, best first. */
export const TIER = { exact: 0, starts: 1, words: 2, title: 3, field: 4, near: 5 } as const

type Prepared = { title: string; words: string[]; values: string[]; digits: string }
const prepared = new WeakMap<IndexRow, Prepared>()
const WORD = /[^\p{L}\p{N}]+/u

function prepare(row: IndexRow): Prepared {
  let p = prepared.get(row)

  if (!p) {
    const title = fold(row[1])
    const values = row.slice(3).map((v) => (v ? fold(v) : ''))

    p = {
      title,
      words: title.split(WORD).filter(Boolean),
      values,
      digits: values.map(digitsOf).join(' '),
    }

    prepared.set(row, p)
  }

  return p
}

/** How well one typed word matches a record, and which field it was found in when not the title. */
function matchTerm(p: Prepared, term: string): { tier: number; value?: number } | undefined {
  if (p.words.some((w) => w.startsWith(term))) {
    return { tier: TIER.words }
  }

  if (p.title.includes(term)) {
    return { tier: TIER.title }
  }

  const at = p.values.findIndex((v) => v.includes(term))

  if (at >= 0) {
    return { tier: TIER.field, value: at }
  }

  const digits = phoneDigits(term)

  if (digits && p.digits.includes(digits)) {
    return { tier: TIER.field, value: p.values.findIndex((v) => digitsOf(v).includes(digits)) }
  }

  if (p.words.some((w) => nearPrefix(term, w))) {
    return { tier: TIER.near }
  }

  return undefined
}

export type Hit = {
  objectKey: string
  id: string
  title: string
  summary: string
  tier: number
  /** The field the match was found in, and its value, when it wasn't the title. */
  field?: string
  value?: string
}

export type NoteHit = {
  id: string
  title: string
  objectKey: string | null
  recordId: string | null
}

export type Found = {
  /** The strongest few matches of any kind of record. */
  best: Hit[]
  groups: { objectKey: string; hits: Hit[]; total: number }[]
  notes: { hits: NoteHit[]; total: number }
  /** Every record that matched, as `recentKey`s, shown or not: lets a caller tell what the server found that this didn't. */
  matched: Set<string>
}

export const recentKey = (objectKey: string, id: string) => `${objectKey}:${id}`

/**
 * Every record in the index that matches all the typed words, ranked: the whole
 * title, then a title that starts with what was typed, a word that starts with
 * it, a title that contains it, another field that contains it, then
 * near-misses. Ties go to what was opened most recently, then to what changed
 * most recently.
 */
export function searchIndex(
  index: QuickIndex,
  q: string,
  opts: { recent?: string[]; per?: number; best?: number; only?: string } = {},
): Found {
  const { per = 5, best = 5, only } = opts
  const words = terms(q)
  const whole = words.join(' ')
  const empty: Found = { best: [], groups: [], notes: { hits: [], total: 0 }, matched: new Set() }

  if (words.length === 0) {
    return empty
  }

  const recent = new Map((opts.recent ?? []).map((key, i) => [key, i]))
  const NEVER = 1e6

  // `sum` separates records the worst-matched word leaves level: of two that both
  // needed a typo forgiven, the one whose other words matched exactly is closer.
  type Ranked = Hit & { order: number; sum: number }
  const byRank = (a: Ranked, b: Ranked) => a.tier - b.tier || a.sum - b.sum || a.order - b.order
  const all: Ranked[] = []
  const groups: { objectKey: string; hits: Ranked[]; total: number }[] = []
  const matched = new Set<string>()

  for (const [objectKey, object] of Object.entries(index.objects)) {
    if (only && only !== objectKey) {
      continue
    }

    const hits: Ranked[] = []

    object.rows.forEach((row, position) => {
      const p = prepare(row)
      let tier = 0
      let sum = 0
      let value: number | undefined

      for (const term of words) {
        const m = matchTerm(p, term)

        if (!m) {
          return
        }

        sum += m.tier

        if (m.tier > tier) {
          tier = m.tier
        }

        if (m.value !== undefined && value === undefined) {
          value = m.value
        }
      }

      if (tier <= TIER.title) {
        if (p.title === whole) {
          tier = TIER.exact
        } else if (p.title.startsWith(whole)) {
          tier = TIER.starts
        }
      }

      const hit: Ranked = {
        objectKey,
        id: row[0],
        title: row[1],
        summary: row[2],
        tier,
        sum,
        order: (recent.get(recentKey(objectKey, row[0])) ?? NEVER) * 1e7 + position,
      }

      // The field the match was found in, shown when it wasn't the title.
      if (tier >= TIER.field && value !== undefined && value >= 0) {
        hit.field = object.fields[value]
        hit.value = row[3 + value] ?? undefined
      }

      hits.push(hit)
    })

    if (hits.length === 0) {
      continue
    }

    for (const hit of hits) {
      matched.add(recentKey(objectKey, hit.id))
    }

    hits.sort(byRank)
    groups.push({ objectKey, hits: hits.slice(0, per), total: hits.length })
    all.push(...hits.slice(0, best))
  }

  all.sort(byRank)

  const notes: NoteHit[] = []

  if (!only) {
    for (const [id, title, objectKey, recordId] of index.notes.rows) {
      const folded = fold(title)

      if (words.every((t) => folded.includes(t))) {
        notes.push({ id, title, objectKey, recordId })
      }
    }
  }

  const strip = ({ order: _order, sum: _sum, ...hit }: Ranked): Hit => hit
  return {
    best: groups.length > 1 ? all.slice(0, best).map(strip) : [],
    groups: groups.map((g) => ({ ...g, hits: g.hits.map(strip) })),
    notes: { hits: notes.slice(0, per), total: notes.length },
    matched,
  }
}

export type MergedIndex = { index: QuickIndex; complete: boolean }

/**
 * The index after the server's answer to "what changed since". Changed records
 * replace their old rows and go first. `complete` is false when the counts no
 * longer add up (something was deleted), and the whole index should be fetched again.
 */
export function mergeIndex(held: QuickIndex, changes: QuickIndex): MergedIndex {
  let complete = true
  const objects: QuickIndex['objects'] = {}

  for (const [key, next] of Object.entries(changes.objects)) {
    const old = held.objects[key]
    const fresh = new Set(next.rows.map((r) => r[0]))

    const kept =
      old && old.fields.join() === next.fields.join()
        ? old.rows.filter((r) => !fresh.has(r[0]))
        : []

    const rows = [...next.rows, ...kept].slice(0, INDEX_LIMIT)

    if (rows.length !== Math.min(next.total, INDEX_LIMIT)) {
      complete = false
    }

    objects[key] = { fields: next.fields, rows, total: next.total }
  }

  const freshNotes = new Set(changes.notes.rows.map((r) => r[0]))
  const notes = [...changes.notes.rows, ...held.notes.rows.filter((r) => !freshNotes.has(r[0]))]

  if (notes.length !== changes.notes.total) {
    complete = false
  }

  return {
    index: {
      at: changes.at,
      objects,
      notes: { rows: notes, total: changes.notes.total },
      views: changes.views,
    },
    complete,
  }
}

/**
 * Holds the index for a browser tab. The first `refresh` fetches all of it;
 * later ones ask only for what changed, and only when it is older than
 * `freshMs` or something was changed here (`stale`). Whoever asked is handed
 * what is held at once and told when a newer one arrives (`subscribe`).
 */
export function createIndexStore(
  fetchIndex: (since?: string) => Promise<QuickIndex>,
  { freshMs = 30_000, now = Date.now }: { freshMs?: number; now?: () => number } = {},
) {
  let held: QuickIndex | undefined
  let checked = 0
  let stale = false
  let loading: Promise<QuickIndex> | undefined
  const listeners = new Set<() => void>()

  async function load(): Promise<QuickIndex> {
    if (held) {
      const { index, complete } = mergeIndex(held, await fetchIndex(held.at))
      // Counts that don't add up mean something was deleted: start again from everything.
      held = complete ? index : await fetchIndex()
    } else {
      held = await fetchIndex()
    }

    checked = now()
    stale = false

    for (const listener of listeners) {
      listener()
    }

    return held
  }

  return {
    get: (): QuickIndex | undefined => held,
    /** The index, brought up to date first when it is old or marked stale. */
    refresh(): Promise<QuickIndex> {
      if (loading) {
        return loading
      }

      if (held && !stale && now() - checked < freshMs) {
        return Promise.resolve(held)
      }

      const request = load().finally(() => {
        if (loading === request) {
          loading = undefined
        }
      })

      loading = request
      return request
    },
    /** Something changed in this tab: check with the server before the index is next used. */
    stale(): void {
      stale = true
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// ── Showing a match ─────────────────────────────────────────────────────────

/** Text cut into pieces, the ones that match what was typed marked, for highlighting. */
export function highlight(text: string, q: string): { text: string; hit: boolean }[] {
  const folded = fold(text)
  const words = terms(q)

  if (folded.length !== text.length || words.length === 0) {
    return [{ text, hit: false }]
  }

  const marks = Array.from({ length: text.length }, () => false)

  for (const term of words) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      marks.fill(true, at, at + term.length)
    }
  }

  const out: { text: string; hit: boolean }[] = []

  for (let i = 0; i < text.length;) {
    let j = i

    while (j < text.length && marks[j] === marks[i]) {
      j++
    }

    out.push({ text: text.slice(i, j), hit: marks[i] === true })
    i = j
  }

  return out
}

/** A stretch of a long text around the first place it matches, on one line. */
export function snippet(text: string, q: string, width = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  if (flat.length <= width) {
    return flat
  }

  const folded = fold(flat)

  const found = terms(q)
    .map((t) => folded.indexOf(t))
    .filter((at) => at >= 0)

  const at = found.length > 0 ? Math.min(...found) : 0
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width))
  const cut = flat.slice(start, start + width)
  return `${start > 0 ? '…' : ''}${cut}${start + width < flat.length ? '…' : ''}`
}

// ── What the server finds ───────────────────────────────────────────────────

/** A match the server found: in a field the browser isn't given, or inside a note, an email, a call or a task. */
export type DeepHit = {
  kind: 'record' | 'note' | 'email' | 'call' | 'meeting' | 'task'
  id: string
  title: string
  /** The matching text, when it wasn't the title. */
  snippet?: string
  /** For a record: the field the match was in. */
  field?: string
  /** The record this is, or is attached to. */
  objectKey: string | null
  recordId: string | null
  recordTitle?: string | null
  at?: string
}

// ── Recently opened ─────────────────────────────────────────────────────────

export type Recent = { objectKey: string; id: string; title: string }
export const RECENT_LIMIT = 30

/** The list of recently opened records with this one moved (or added) to the front. */
export function withRecent(list: Recent[], item: Recent): Recent[] {
  return [item, ...list.filter((r) => r.objectKey !== item.objectKey || r.id !== item.id)].slice(
    0,
    RECENT_LIMIT,
  )
}
