import type { EmailSender } from '../server/email'
import type { IntegrationProvider } from '../server/integrations'
import type { CrmRecord } from '../server/records'

/**
 * The extension contract. Your app's extensions live in src/app/extensions.ts,
 * which is the one server file the framework expects you to edit.
 */

/** Who caused a change. `null` means nobody was signed in (a script, an import). */
export type Actor = { id: string; email: string; name?: string } | null

export type RunContext = {
  objectKey: string
  record: CrmRecord
  actor: Actor
  /** What fired this run: "action:<id>" or "<objectKey>.<created|updated|deleted>". */
  trigger: string
}

export type RunResult = { message: string }

/** Handles every `"<kind>:<name>"` target of one kind. */
export type RunTargetHandler = {
  /** Return an error message if `name` can't be resolved; checked by crm:gen and at start-up. */
  validate?: (name: string) => string | null
  run: (name: string, ctx: RunContext) => Promise<RunResult>
}

export type Hooks = {
  /** Change or reject the values before a record is created. Throw to reject. */
  beforeCreate?: (e: {
    objectKey: string
    values: Record<string, unknown>
    actor: Actor
  }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  afterCreate?: (e: { objectKey: string; record: CrmRecord; actor: Actor }) => Promise<void> | void
  /** Change or reject an update. `values` holds only the fields being changed. Throw to reject. */
  beforeUpdate?: (e: {
    objectKey: string
    id: string
    values: Record<string, unknown>
    previous: CrmRecord
    actor: Actor
  }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  afterUpdate?: (e: {
    objectKey: string
    record: CrmRecord
    previous: CrmRecord
    actor: Actor
  }) => Promise<void> | void
  afterDelete?: (e: { objectKey: string; record: CrmRecord; actor: Actor }) => Promise<void> | void
}

export type Extensions = {
  /** Functions referenced from the config as `"run": "local:<name>"`. */
  handlers?: Record<string, (ctx: RunContext) => Promise<RunResult>>
  /** Extra run-target kinds, e.g. `{ slack: {...} }` enables `"run": "slack:<channel>"`. */
  runTargets?: Record<string, RunTargetHandler>
  /** Record lifecycle hooks. They run for the CRM UI and the assistant alike. */
  hooks?: Hooks
  /** Replace the campaign email transport (default: Resend). */
  email?: { send: EmailSender }
  /**
   * Services teammates can connect on the Integrations page, by id. The framework
   * runs the OAuth flow and stores the tokens encrypted; your handlers get a
   * current token from `getAccessToken` in src/server/integrations.ts.
   */
  integrations?: Record<string, IntegrationProvider>
  /** How files attached to records are laid out in the file store. */
  files?: {
    /**
     * The folder a record's files go in, as a path from the drive's root, e.g.
     * "Jobs/2026/Henderson kitchen". Asked once, at the record's first upload,
     * and kept from then on. Default: "<Object's plural label>/<Record title> (<short id>)".
     */
    location?: (e: { objectKey: string; record: CrmRecord }) => Promise<string> | string
  }
}

/** Identity helper that type-checks your extensions. */
export function defineExtensions(extensions: Extensions): Extensions {
  return extensions
}
