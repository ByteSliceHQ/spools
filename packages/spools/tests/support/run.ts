import { ConfigProvider, Effect, type Layer, ManagedRuntime } from 'effect'

import { type AppServices, appLayer, installRuntime, runServer } from '../../src/server/runtime/app'
import type { Query, Which } from '../../src/server/store/query'
import { Store } from '../../src/server/store/store'
import type { Table } from '../../src/server/store/table'

/**
 * Running Effect programs in tests.
 *
 * Integration tests use `run` and `failure`, which run on the app's own
 * runtime, on the store TEST_STORE names (tests/support/preload.ts). Unit tests build a runtime from fake layers with `testRuntime`
 * and read configuration from a plain object with `withEnv`.
 */

/** Runs a program on the app's runtime and returns what it succeeds with. */
export const run = <A, E>(program: Effect.Effect<A, E, AppServices>): Promise<A> =>
  runServer(program)

/** Runs a program that should fail, and returns its typed error (rejecting if it succeeds). */
export const failure = <A, E>(program: Effect.Effect<A, E, AppServices>): Promise<E> =>
  runServer(Effect.flip(program))

/** The store itself, as promises, for putting rows in place and checking what is there. */
export const db = {
  find: <Row, Insert, S extends keyof Row = keyof Row>(
    table: Table<Row, Insert>,
    query?: Query<Row, S>,
  ) => run(Store.use((store) => store.find(table, query))),
  first: <Row, Insert, S extends keyof Row = keyof Row>(
    table: Table<Row, Insert>,
    query: Query<Row, S>,
  ) => run(Store.use((store) => store.first(table, query))),
  insert: <Row, Insert>(table: Table<Row, Insert>, values: Insert) =>
    run(Store.use((store) => store.insert(table, values))),
  update: <Row, Insert>(table: Table<Row, Insert>, which: Which<Row>, changes: Partial<Insert>) =>
    run(Store.use((store) => store.update(table, which, changes))),
  remove: <Row, Insert>(table: Table<Row, Insert>, which: Which<Row>) =>
    run(Store.use((store) => store.remove(table, which))),
}

/** A runtime built from the given layers only: what a program asks for and isn't there doesn't compile. */
export const testRuntime = <R>(layer: Layer.Layer<R>) => ManagedRuntime.make(layer)

/** Configuration read from this object instead of the environment. */
export const withEnv = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env))

/** Runs a program that needs nothing but configuration, with these variables. */
export const runWithEnv = <A, E>(
  env: Record<string, string>,
  program: Effect.Effect<A, E>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(withEnv(env))))

/**
 * Runs the app (its runtime, the boundary, `runServer`) with stand-ins for
 * outside services: `fetch` answers every outside HTTP call (the file store's
 * fake, Google, Microsoft), `auth` the auth provider, `vault` the cipher
 * (`Vault.layerTest`), `signIns` the sign-in accounts and their tokens
 * (`SignIns.layerTest`). Starts from fresh services, so
 * nothing one test learned (a cached folder, a client profile) leaks into the
 * next. Call `installLiveServices()` when done.
 */
export const installStandIns = (swap: Parameters<typeof appLayer>[0]) =>
  installRuntime(appLayer(swap))

/** Back to the real services. */
export const installLiveServices = () => installRuntime(appLayer())

/** A request body as text, whichever form Effect's HTTP client sent it in (stand-ins read bodies with this). */
export const bodyText = (init?: RequestInit): string => {
  const body = init?.body

  if (body === undefined || body === null) {
    return ''
  }

  if (typeof body === 'string') {
    return body
  }

  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body)
  }

  return String(body)
}
