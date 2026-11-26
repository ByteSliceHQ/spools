import type { EmailSender } from '../server/email'
import type { IntegrationProvider } from '../server/integrations'
import type { CrmRecord } from '../server/records'
import type { CrmUser } from '../server/users'
import type { ScopeGrant, ScopeInfo } from './scopes'

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

/** What a network's code is handed to reach the account. */
export type NetworkAccess =
  /** A connection to one of the app's `integrations`, by id: a teammate connects it on the Integrations page. */
  | { integration: string }
  /** A token whoever runs the CRM sets in the environment, by the variable's name. */
  | { env: string }

/** A post as a network's code receives it. */
export type PostToPublish = {
  /** The body, then the link on a line of its own. */
  text: string
  body: string
  link: string | null
  /** `account` from the channel in crm.config.json: a page, an organisation, a handle. */
  account: string
  /** The access token, when the network names how to get one. */
  token: string | null
}

/** Where a published post is. */
export type PublishedPost = { id: string; url?: string | null }

/**
 * A social network posts can go to. With `publish`, the CRM sends the post
 * itself. Without it, the network is only reachable through the agent engine
 * (a `publish_<network>` workflow), which a channel can also ask for with
 * `"via": "swirls"`.
 */
export type PostNetwork = {
  label: string
  /** The longest post the network takes. */
  limit: number
  /** What a link counts as, where the network counts every link the same. */
  linkLength?: number
  access?: NetworkAccess
  /** Send one post. Throw to refuse it: the message is what the team reads. */
  publish?: (post: PostToPublish) => Promise<PublishedPost>
}

/** One ad campaign's results over a period, as a network's code reads them. */
export type AdCampaignResults = {
  externalId: string
  name: string
  status: string
  currency?: string | null
  spend?: number
  impressions?: number
  clicks?: number
  conversions?: number
  dailyBudget?: number | null
}

/** An ad network whose results the CRM can show. Without `read` it is only reachable through an `ads_<network>` workflow. */
export type AdNetwork = {
  label: string
  access?: NetworkAccess
  /** Every campaign in the account, with its results over the last `days`. */
  read?: (ctx: {
    account: string
    token: string | null
    days: number
  }) => Promise<AdCampaignResults[]>
}

/**
 * Who holds which scope, for a Spool with `scopes` in crm.config.json whose
 * auth adapter doesn't say (or whose groups are kept somewhere of your own: a
 * table, a directory, a payroll system). Asked on each request: cache what is slow.
 */
export type ScopeSource = {
  /** The scopes this person holds, each with a role from `scopes.roles`. Nothing held means they see no scoped record. */
  grants: (user: CrmUser) => Promise<ScopeGrant[]> | ScopeGrant[]
  /** Every scope there is, for people whose role reaches all of them. */
  list?: () => Promise<ScopeInfo[]> | ScopeInfo[]
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
  /**
   * Networks for the Marketing page, by the key a channel or an ad account
   * names as its `network`. One of the same key as a built-in network replaces it.
   */
  marketing?: {
    posts?: Record<string, PostNetwork>
    ads?: Record<string, AdNetwork>
  }
  /** Who holds which record scope. See `scopes` in docs/configuration.md. */
  scopes?: ScopeSource
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
