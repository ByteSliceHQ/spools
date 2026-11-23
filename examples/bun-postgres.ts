import { SQL } from 'bun'
import { Effect, Layer } from 'effect'

import {
  callbackTransaction,
  DatabaseError,
  makeStore,
  placeholders,
  sqlBackend,
  Store,
  type StoreAdapter,
} from '@swirls/spools/adapter'

/** Any Postgres, through Bun's own client. */
export const bunPostgres = (url: string): StoreAdapter => ({
  id: 'bun-postgres',
  label: 'Postgres',
  layer: Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = new SQL(url)
      yield* Effect.addFinalizer(() => Effect.promise(() => sql.close()))

      // Bun's transaction takes a callback, and hands it the connection to use.
      const transaction = callbackTransaction<SQL>((work) => sql.begin((tx) => work(tx)))

      return Store.of(
        makeStore(
          sqlBackend((query) => {
            const { text, params } = placeholders(query)

            // Inside a transaction a statement is the transaction's; otherwise the pool's.
            return Effect.flatMap(transaction.current, (tx) =>
              Effect.tryPromise({
                try: () => (tx ?? sql).unsafe(text, [...params]),
                catch: (cause) => new DatabaseError({ cause }),
              }),
            )
          }, transaction.transact),
        ),
      )
    }),
  ),
})
