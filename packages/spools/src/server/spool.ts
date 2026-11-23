import { type CrmConfig, crmConfigSchema } from '../crm/config-schema'
import type { Extensions } from '../crm/extensions'
import type { Adapter } from './runtime/adapter'
import type { AgentsAdapter } from './runtime/agents'
import type { AuthAdapter } from './runtime/auth'
import type { EmailAdapter } from './runtime/email'
import type { FilesAdapter } from './runtime/files'
import type { VaultAdapter } from './runtime/vault'
import { type ObjectTable, objectTables } from './store/objects'
import type { StoreAdapter } from './store/store'

/**
 * A Spool: one business's CRM, put together from its config, its own code and
 * the adapters it runs on. An app makes one in `src/spool.server.ts`:
 *
 *   export default defineSpool({
 *     crm,                      // crm.config.json
 *     extensions,               // src/app/extensions.ts
 *     auth: clerk(),
 *     database: postgres(),
 *     agents: swirls(),
 *   });
 *
 * The framework never imports the app. It reads the app's Spool from here, and
 * there is one per server process, as there is one Effect runtime
 * (runtime/app.ts): a deployment serves a single business.
 *
 * Server-side only. The browser receives a copy of the config without the
 * access list (`toPublicConfig` in src/crm/config.ts).
 */
export type SpoolOptions = {
  /** The contents of crm.config.json. Checked against the contract in src/crm/config-schema.ts. */
  crm: unknown
  /** The app's own server code: hooks, handlers, run targets. */
  extensions?: Extensions
  /** Who signs people in. */
  auth: AuthAdapter
  /** Where records are kept. */
  database: StoreAdapter
  /** Where files are kept. Without one, the Files pages say files aren't set up. */
  files?: FilesAdapter
  /** What sends campaign email. Without one, emails are logged. */
  email?: EmailAdapter
  /** What encrypts stored secrets. Without one, none are stored. */
  vault?: VaultAdapter
  /** What runs agents and workflows. Without one, workflows are skipped and the assistant is off. */
  agents?: AgentsAdapter
}

export type Spool = {
  readonly config: CrmConfig
  readonly extensions: Extensions
  readonly auth: AuthAdapter
  readonly database: StoreAdapter
  readonly files: FilesAdapter | undefined
  readonly email: EmailAdapter | undefined
  readonly vault: VaultAdapter | undefined
  readonly agents: AgentsAdapter | undefined
}

/** What every adapter has, whichever service it provides. */
type AnyAdapter = Omit<Adapter<never>, 'layer'>

declare global {
  /**
   * This process's Spool. It lives on the global object so that every copy of
   * this module (the app's bundle, the dev server's own) sees the same one.
   */
  var spoolsSpool: Spool | undefined
}

/**
 * Checks the options and makes them this process's Spool. Throws, naming every
 * problem, when the config doesn't satisfy the contract.
 */
export function defineSpool(options: SpoolOptions): Spool {
  const made: Spool = {
    config: crmConfigSchema.parse(options.crm),
    extensions: options.extensions ?? {},
    auth: options.auth,
    database: options.database,
    files: options.files,
    email: options.email,
    vault: options.vault,
    agents: options.agents,
  }

  globalThis.spoolsSpool = made
  return made
}

/** The adapters a Spool uses, whatever their port. */
export const adaptersOf = ({ auth, database, files, email, vault, agents }: Spool): AnyAdapter[] =>
  [auth, database, files, email, vault, agents].filter((a) => a !== undefined)

/** This process's Spool. */
export function spool(): Spool {
  const current = globalThis.spoolsSpool

  if (!current) {
    throw new Error(
      'No Spool is defined. Import src/spool.server.ts (it calls defineSpool) before using the server.',
    )
  }

  return current
}

/** The validated config. */
export const crmConfig = (): CrmConfig => spool().config

/** One object from the config. An unknown key is a bug in the caller: input is checked before it gets here. */
export function getObject(objectKey: string) {
  const { objects } = crmConfig()
  const obj = Object.hasOwn(objects, objectKey) ? objects[objectKey] : undefined

  if (!obj) {
    throw new Error(`Unknown object "${objectKey}"`)
  }

  return obj
}

/** The table an object's records are in. */
export function objectTable(objectKey: string): ObjectTable {
  getObject(objectKey)
  const table = objectTables(crmConfig())[objectKey]

  // Every object of the config has a table, so this is the object being unknown.
  if (!table) {
    throw new Error(`Unknown object "${objectKey}"`)
  }

  return table
}
