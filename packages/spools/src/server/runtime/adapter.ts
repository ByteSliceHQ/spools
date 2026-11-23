import type { Layer } from 'effect'
import type { HttpClient } from 'effect/http'

import type { Store } from '../store/store'
import type { AnyTable } from '../store/table'

/**
 * An adapter puts one outside service behind one of the CRM's ports. A port is
 * an Effect service the framework asks for (`Auth`, `Store`, `FileStore`,
 * `Email`, `Vault`, `Agents`); an adapter is a layer that provides it, and what
 * the server needs to know about it at start-up. A Spool chooses one adapter
 * per port (src/server/spool.ts). See docs/adapters.md.
 */
export type Adapter<Service> = {
  /** A short name for logs and the boot report, e.g. "clerk". */
  readonly id: string
  /** What the service is called, as staff see it, e.g. "Clerk". */
  readonly label: string
  /**
   * Provides the port. It may ask for the HTTP client and (except the database
   * adapter) the `Store`; its settings come from `Config` (runtime/config.ts).
   */
  readonly layer: Layer.Layer<Service, never, HttpClient.HttpClient | Store>
  /** Variables that must be set. A missing or malformed one stops a production server from starting. */
  readonly requires?: readonly Requirement[]
  /** Optional things the environment switches on, for the boot report. */
  readonly features?: readonly Feature[]
  /**
   * Tables the adapter keeps in the Spool's own database (store/table.ts). They
   * are made with the rest: `bun run crm:gen` puts them in the schema. The
   * adapter reaches them through the `Store`.
   */
  readonly tables?: readonly AnyTable[]
}

export type Env = Record<string, string | undefined>

/** A variable that must be set. */
export type Requirement = {
  name: string
  /** Other variables that do instead when `name` is unset. */
  or?: readonly string[]
  /** What is wrong with a value, or null. Only asked about a value that is set. */
  check?: (value: string) => string | null
}

/** A feature the environment switches on, for the boot report (`[env] Files on records: on`). */
export type Feature = { name: string; vars: readonly string[]; check?: (env: Env) => string | null }

/** A variable must be at least this long. */
export const atLeast = (name: string, length: number) => (env: Env) =>
  (env[name]?.length ?? 0) < length ? `${name} must be at least ${length} characters` : null
