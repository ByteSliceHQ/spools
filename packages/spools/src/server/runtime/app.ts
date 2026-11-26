import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect'

import { MarketingSource } from '../marketing-source'
import { Scopes } from '../scopes'
import { Sequences } from '../sequences'
import { SignIns } from '../sign-ins'
import { spool } from '../spool'
import { type Store, storeLayer } from '../store/store'
import { Users } from '../users'
import { carriedAccess, CurrentAccess } from './access'
import { Agents } from './agents'
import type { Auth } from './auth'
import { Email } from './email'
import { DatabaseError } from './errors'
import { FileStore } from './files'
import { type Fetch, httpLayer } from './http'
import type { CurrentRequest } from './request'
import { Vault } from './vault'

/**
 * The services every server program can use, and the one runtime per server
 * process that provides them. The ones the Spool chose (src/server/spool.ts)
 * come from its adapters; tests pass stand-ins instead.
 *
 * A new outside service is added here (its live layer) and in its tests (a
 * fake layer). Programs ask for a service with `yield* Store`; the
 * compiler refuses a program that needs a service this layer doesn't provide.
 */
export function appLayer(
  swap: {
    fetch?: Fetch
    store?: Layer.Layer<Store>
    auth?: Layer.Layer<Auth>
    files?: Layer.Layer<FileStore>
    vault?: Layer.Layer<Vault>
    signIns?: Layer.Layer<SignIns>
    email?: Layer.Layer<Email>
    agents?: Layer.Layer<Agents>
    sequences?: Layer.Layer<Sequences>
    marketing?: Layer.Layer<MarketingSource>
    scopes?: Layer.Layer<Scopes>
  } = {},
) {
  return Layer.mergeAll(
    swap.files ?? spool().files?.layer ?? FileStore.none,
    swap.vault ?? spool().vault?.layer ?? Vault.none,
    swap.signIns ?? SignIns.layer,
    swap.email ?? spool().email?.layer ?? Email.log,
    swap.sequences ?? Sequences.layer,
    swap.marketing ?? MarketingSource.layer,
    swap.scopes ?? Scopes.layer,
    swap.agents ?? spool().agents?.layer ?? Agents.none,
  ).pipe(
    Layer.provideMerge(Users.layer),
    Layer.provideMerge(swap.auth ?? spool().auth.layer),
    // Beneath the rest: an adapter may keep tables of its own in the Spool's database.
    Layer.provideMerge(swap.store ?? spool().database.layer),
    Layer.provideMerge(httpLayer(swap.fetch)),
    Layer.provideMerge(ConfigProvider.layer(liveEnvironment)),
  )
}

/**
 * Configuration read from `process.env` each time, as the code before Effect
 * read it: a value set or fixed while the process runs takes effect at once
 * (adopters' tests and hooks set variables as they go). Effect's own
 * provider keeps the first copy it reads.
 */
const liveEnvironment = ConfigProvider.make((path) =>
  Effect.suspend(() => ConfigProvider.fromEnvRecord({ ...process.env }).load(path)),
)

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>

export type { Session } from './auth'
export { CurrentRequest } from './request'

/** What a server function's or route's program may require. */
export type Services = AppServices | CurrentRequest

type Runtime = ManagedRuntime.ManagedRuntime<AppServices, never>
const key = Symbol.for('crm.runtime')
// SAFETY: a global can't be declared under a symbol, so TypeScript can't type this slot. Only
// this module writes it, always with a `Runtime`; the starter's server.prod.ts reads it by the
// same key (and checks it) to dispose the runtime on shutdown, so the key stays a symbol.
const store = globalThis as typeof globalThis & { [key]?: Runtime }

/**
 * The runtime, built on first use. Kept on `globalThis` so a dev-server reload
 * doesn't open a second database pool. On a serverless host each
 * instance builds one and reuses it for every request it serves.
 */
export function runtime(): Runtime {
  store[key] ??= ManagedRuntime.make(appLayer(), { memoMap: Layer.makeMemoMapUnsafe() })
  return store[key]
}

/**
 * Replaces the process's runtime with one built from `layer` (tests, and
 * harnesses that stand in for an outside service). Everything that runs
 * programs, the boundary and `runServer` included, uses it from then on.
 * Disposes the one it replaces.
 */
export async function installRuntime(layer: Layer.Layer<AppServices>): Promise<void> {
  const previous = store[key]
  store[key] = ManagedRuntime.make(layer, { memoMap: Layer.makeMemoMapUnsafe() })
  await previous?.dispose()
}

/** Closes the pool and stops what the runtime started. For shutdown (server.prod.ts) and tests. */
export async function disposeRuntime(): Promise<void> {
  const current = store[key]
  store[key] = undefined
  await current?.dispose()
}

/**
 * Runs a program from code that is still plain promises (a module not yet
 * converted, a script, the adopter's extensions). It fails the way the
 * program does: a typed error is thrown as itself, so its `message` is what
 * staff see.
 */
export function runServer<A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A> {
  // Called from an app's hook, this works with the access of whoever called the hook (access.ts).
  // Called from anywhere else, nobody has said, and a scoped table refuses until the program does.
  const access = carriedAccess()
  return runtime().runPromise(
    access ? Effect.provideService(program, CurrentAccess, access) : program,
  )
}

const refuse = () => Effect.fail(new DatabaseError({ cause: "The server isn't running" }))

/** A store with no database behind it. */
const noStore = storeLayer(
  Effect.sync(() => ({
    find: refuse,
    count: refuse,
    countValues: refuse,
    insert: refuse,
    update: refuse,
    remove: refuse,
    refreshDates: refuse,
    lock: refuse,
    transaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program,
    ping: refuse(),
  })),
)

/**
 * What is missing before files can be used, at once, for an app's code that
 * can't wait. While the services are up it is asked of them. Where they aren't
 * (an app's own tests, the start of a script) it is asked of the Spool's file
 * store alone: what is missing is a matter of settings, so nothing is opened to
 * find out.
 */
export function filesProblems(): string[] {
  const problems = FileStore.use((files) => files.problems)
  const current = store[key]

  if (current?.cachedContext) {
    return current.runSync(problems)
  }

  const alone = (spool().files?.layer ?? FileStore.none).pipe(
    Layer.provide(noStore),
    Layer.provide(httpLayer()),
    Layer.provideMerge(ConfigProvider.layer(liveEnvironment)),
  )

  return Effect.runSync(Effect.provide(problems, alone))
}
