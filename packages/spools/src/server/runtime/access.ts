import { AsyncLocalStorage } from 'node:async_hooks'

import { Context } from 'effect'

import type { ScopeAccess } from '../../crm/scopes'

/**
 * What the program running may reach, in a Spool with record scopes
 * (src/crm/scopes.ts). Null means nobody said: a scoped table then refuses the
 * call (src/server/store/scope.ts). Set by the boundary for a signed-in person,
 * by the tool route from a signed grant, and by `asSystem` for the server's own
 * work (src/server/scopes.ts).
 */
export const CurrentAccess = Context.Reference<ScopeAccess | null>('spools/access', {
  defaultValue: () => null,
})

/**
 * The person the program running is working for, by user id, when its access
 * is a person's: set by `asUser` for someone signed in, and by the tool route
 * from a grant that was made for someone. Null for the server's own work. A
 * grant minted while it is set is that person's (`grantFor` in scopes.ts),
 * whoever the change is put down to: an assistant's update is still for the
 * person whose workflow it is.
 */
export const CurrentPerson = Context.Reference<string | null>('spools/access/person', {
  defaultValue: () => null,
})

/** One record, by its object and id. */
export type BoundRecord = { readonly objectKey: string; readonly recordId: string }

/**
 * The one record the program running may be about, when its access came from a
 * grant made for a record. Null means no such limit. The tool API reads it
 * (src/server/tools.ts).
 */
export const CurrentRecord = Context.Reference<BoundRecord | null>('spools/access/record', {
  defaultValue: () => null,
})

/**
 * An app's own code (a hook, a handler, a run target) is plain promises: it
 * calls back in through `@swirls/spools/extensions`, which starts a new program
 * that knows nothing of the one that called the hook. So the access is carried
 * across in the call's own async context: `fromHook` (errors.ts) puts it there,
 * and `runServer` (app.ts) takes it up. Only the caller's access is ever
 * carried. Outside a hook there is none, and nothing is assumed.
 */
type Carried = { readonly access: ScopeAccess | null; readonly person: string | null }

declare global {
  /** On the global object so every copy of this module (the app's bundle, the dev server's own) shares one. */
  var spoolsAccessCarrier: AsyncLocalStorage<Carried> | undefined
}

const carrier = (): AsyncLocalStorage<Carried> => {
  globalThis.spoolsAccessCarrier ??= new AsyncLocalStorage<Carried>()
  return globalThis.spoolsAccessCarrier
}

/** The person whose work the app's code this is running in was called for, or null. */
export const carriedPerson = (): string | null => carrier().getStore()?.person ?? null

/**
 * Calls the app's code with the caller's access, and the person it is working
 * for, in reach of what it calls back into. Without `person`, whoever was
 * already carried still is.
 */
export const carrying = <A>(
  access: ScopeAccess | null,
  call: () => A,
  person: string | null = carriedPerson(),
): A => carrier().run({ access, person }, call)

/** The access of whoever called the app's code this is running in, or null. */
export const carriedAccess = (): ScopeAccess | null => carrier().getStore()?.access ?? null
