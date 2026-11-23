import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted } from 'effect'

import type { Env, Requirement } from '../../../server/runtime/adapter'
import * as config from '../../../server/runtime/config'
import { sqlStore } from '../../../server/store/sql-store'
import type { StoreAdapter } from '../../../server/store/store'

/**
 * Any Postgres 15 or newer, reached with a connection string: Supabase, Neon,
 * RDS, Fly, your own server.
 *
 *   DATABASE_URL   the connection string
 *   POSTGRES_URL   used when DATABASE_URL is unset (some hosting integrations set it)
 *
 * The tables are made and migrated with Prisma (`bun run db:push`, `db:migrate`).
 */

/**
 * The Postgres connection string. `DATABASE_URL` wins. Without it, use `POSTGRES_URL`,
 * which some hosting integrations set (Supabase's, per preview branch). That one asks for
 * `sslmode=require`, and the driver then rejects the pooler's certificate chain, so
 * it is relaxed to `no-verify`: still TLS, without checking the chain.
 */
export function databaseUrl(env: Env): string | undefined {
  if (env['DATABASE_URL']) {
    return env['DATABASE_URL']
  }

  const fallback = env['POSTGRES_URL']

  if (!fallback || !URL.canParse(fallback)) {
    return fallback || undefined
  }

  const url = new URL(fallback)

  if (url.searchParams.get('sslmode') === 'require') {
    url.searchParams.set('sslmode', 'no-verify')
  }

  return url.toString()
}

/** The variable every Postgres adapter needs. */
export const DATABASE_URL: Requirement = {
  name: 'DATABASE_URL',
  or: ['POSTGRES_URL'],
  check: (value) => (URL.canParse(value) ? null : 'must be a Postgres connection string'),
}

/**
 * How to reach a database, from its connection string. `sslmode` is the
 * driver's `ssl` option; a transaction pooler (Supabase's port 6543) can't keep
 * prepared statements between queries.
 */
export function connection(url: string) {
  const parsed = new URL(url)
  const mode = parsed.searchParams.get('sslmode')
  parsed.searchParams.delete('sslmode')
  parsed.searchParams.delete('supa')
  return {
    url: parsed.toString(),
    ssl:
      mode === null || mode === 'disable'
        ? undefined
        : mode === 'no-verify'
          ? { rejectUnauthorized: false }
          : true,
    prepare: parsed.port !== '6543',
  }
}

export type PostgresOptions = {
  /** Connections kept open at most. Default 10. */
  maxConnections?: number
}

export const postgres = ({ maxConnections = 10 }: PostgresOptions = {}): StoreAdapter => ({
  id: 'postgres',
  label: 'Postgres',
  requires: [DATABASE_URL],
  layer: sqlStore.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.map(config.environment, (env) => {
          const { url, ...options } = connection(databaseUrl(env) ?? 'postgres://unset')
          return PgClient.layer({
            url: Redacted.make(url),
            ...options,
            maxConnections,
            applicationName: 'spools',
          })
        }),
      ),
    ),
    Layer.orDie,
  ),
})
