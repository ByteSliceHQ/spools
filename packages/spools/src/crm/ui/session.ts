import { z } from 'zod'

import {
  getCrmSession,
  relationTitlesFn,
  searchIndexFn,
  searchRelationFn,
} from '../../server/crm.functions'
import { createMemory } from '../memory'
import { createIndexStore, type QuickIndex } from '../search'

/**
 * What the browser remembers between pages: who is signed in, the config, the
 * team, and what relation pickers were last given for a search. Without it every
 * click (and every link the pointer passes over) would start with a request for
 * the session, and every picker opened twice would ask twice.
 *
 * This is a convenience for the interface, not access control: every server
 * function still checks the session itself. Nothing is remembered on the server.
 *
 * `router.invalidate()` (called after every change) forgets all of it; see
 * `src/router.tsx`.
 */

export type CrmSession = Awaited<ReturnType<typeof getCrmSession>>

const memory = createMemory({
  session: () => getCrmSession(),
  search: (objectKey: string, q: string) => searchRelationFn({ data: { objectKey, q } }),
  title: async (objectKey: string, id: string) =>
    (await relationTitlesFn({ data: { objectKey, ids: [id] } }))[0]?.title ?? null,
  usable: (s: CrmSession) => s.signedIn && !!s.user,
  scopeOf: (s: CrmSession) => s.scopes?.key,
  // The person switched scope (here, or in another tab): nothing fetched under the old one is shown.
  onScopeChange: () => searchIndex.clear(),
  remember: typeof window !== 'undefined',
})

let scopeNow: string | undefined

/** The record scope this tab last knew it was working in (`scopes.key` of the session), if the Spool has scopes. */
export const currentScope = (): string | undefined => scopeNow

/** The CRM session for a navigation: from memory when the browser has it. */
export const crmSession = () => memory.session()

/** Keep the session the server sent with the page. */
export const rememberCrmSession = (value: CrmSession) => {
  scopeNow = value.scopes?.key
  memory.keep(value)
}

/** One page of an object's records for a relation picker, narrowed by what was typed. */
export const searchRelation = (objectKey: string, q: string) => memory.search(objectKey, q)
/** The title of a record the page holds only the id of. */
export const relationTitle = (objectKey: string, id: string) => memory.title(objectKey, id)

/** The index arrives as one JSON string (see `searchIndexFn`), so it is checked here, where it is read. */
const quickIndexSchema = z.object({
  at: z.string(),
  objects: z.record(
    z.string(),
    z.object({
      fields: z.array(z.string()),
      rows: z.array(z.tuple([z.string(), z.string(), z.string()], z.string().nullable())),
      total: z.number(),
    }),
  ),
  notes: z.object({
    rows: z.array(z.tuple([z.string(), z.string(), z.string().nullable(), z.string().nullable()])),
    total: z.number(),
  }),
  views: z.array(z.object({ id: z.string(), label: z.string(), objectKey: z.string() })),
  scope: z.string().optional(),
}) satisfies z.ZodType<QuickIndex>

/**
 * Every record's title and searchable fields, for the search box to match in
 * the browser. Kept in memory for the life of the tab, never written to disk.
 */
export const searchIndex = createIndexStore(async (since) =>
  quickIndexSchema.parse(JSON.parse(await searchIndexFn({ data: { since } }))),
)

/** Forget everything remembered here. The search index is kept, and checked for changes before its next use. */
export function forgetCrmSession(): void {
  memory.forget()
  searchIndex.stale()
}

/** The cookie the server reads the wanted scope from (`SCOPE_COOKIE` in src/server/scopes.ts). */
const SCOPE_COOKIE = 'spools-scope'

/**
 * Work in another record scope: `null` for all of this person's. The cookie is
 * only a preference, which the server checks against what the person holds on
 * every request. Everything this tab remembered is dropped before anything is
 * asked for again; the caller then reloads what is on screen
 * (`router.invalidate()`).
 */
export function switchScope(scope: string | null): void {
  const value = encodeURIComponent(scope ?? '*')
  document.cookie = `${SCOPE_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`
  memory.forget()
  searchIndex.clear()
}
