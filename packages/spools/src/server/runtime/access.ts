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
 * An app's own code (a hook, a handler, a run target) is plain promises: it
 * calls back in through `@swirls/spools/extensions`, which starts a new program
 * that knows nothing of the one that called the hook. So the access is carried
 * across in the call's own async context: `fromHook` (errors.ts) puts it there,
 * and `runServer` (app.ts) takes it up. Only the caller's access is ever
 * carried. Outside a hook there is none, and nothing is assumed.
 */
type Carried = { readonly access: ScopeAccess | null }

declare global {
  /** On the global object so every copy of this module (the app's bundle, the dev server's own) shares one. */
  var spoolsAccessCarrier: AsyncLocalStorage<Carried> | undefined
}

const carrier = (): AsyncLocalStorage<Carried> => {
  globalThis.spoolsAccessCarrier ??= new AsyncLocalStorage<Carried>()
  return globalThis.spoolsAccessCarrier
}

/** Calls the app's code with the caller's access in reach of what it calls back into. */
export const carrying = <A>(access: ScopeAccess | null, call: () => A): A =>
  carrier().run({ access }, call)

/** The access of whoever called the app's code this is running in, or null. */
export const carriedAccess = (): ScopeAccess | null => carrier().getStore()?.access ?? null
