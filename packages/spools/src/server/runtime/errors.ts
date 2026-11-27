import { Effect, Predicate, Schema } from 'effect'

import { carrying, CurrentAccess, CurrentPerson } from './access'

/**
 * The failures staff can see. Each one's `message` is written for the person
 * using the CRM and is exactly what the browser shows (`err.message`), so the
 * wording here is the wording on screen. The boundary (`boundary.ts`) turns any
 * of these into an `Error` with that message; anything else that goes wrong is
 * a bug (a "defect"), logged in full and rethrown as it is.
 *
 * Errors that belong to one module live next to it and join the `StaffError`
 * union at the bottom of this file.
 */

/** Not signed in, or signed in with an account the config's access list doesn't allow. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {
  reason: Schema.Literals(['signed-out', 'not-allowed']),
}) {
  override get message(): string {
    return this.reason === 'signed-out'
      ? 'Sign in required'
      : 'Your account is not allowed to use this CRM'
  }
}

/** Something that was asked for doesn't exist: `new NotFound({ what: "Record" })` reads "Record not found". */
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { what: Schema.String }) {
  override get message(): string {
    return `${this.what} not found`
  }
}

/** The request asked for something the CRM won't do, said in the message (an unknown guide, a bad value). */
export class Invalid extends Schema.TaggedError<Invalid>()('Invalid', { message: Schema.String }) {}

/** An optional feature was used without the environment it needs. The message says what to set. */
export class NotConfigured extends Schema.TaggedError<NotConfigured>()('NotConfigured', {
  feature: Schema.String,
  message: Schema.String,
}) {}

/**
 * Postgres (through Prisma) refused or failed. Staff see the driver's own
 * message, as they did before Effect. Code that expects a particular failure
 * (a unique index keeping one row) catches this tag and checks.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return messageOf(this.cause)
  }
}

/**
 * The record-scope guard refused a call (src/server/store/scope.ts): a record out
 * of reach, a change someone may only look at, work with nobody said. The message
 * says which, in words for staff. It is its own failure, never a `DatabaseError`,
 * so code that catches a database failure it expects (a unique index keeping one
 * row) doesn't take a refusal for one.
 */
export class ScopeRefused extends Schema.TaggedError<ScopeRefused>()('ScopeRefused', {
  message: Schema.String,
}) {}

/**
 * The auth provider (Clerk, the app's own sign-in) refused or failed. Staff see
 * the provider's own words. `answer`: it said no, and would again. `setup`: it
 * isn't set up for what was asked. `account`: this person's account needs
 * attention. `unavailable`: it had a bad moment.
 */
export class AuthError extends Schema.TaggedError<AuthError>()('AuthError', {
  message: Schema.String,
  kind: Schema.Literals(['answer', 'setup', 'account', 'unavailable']),
}) {}

/**
 * An outside service took longer than its time limit (`policies.ts`). The CRM
 * stopped waiting; the work on the other side may still finish.
 */
export class Timeout extends Schema.TaggedError<Timeout>()('Timeout', { service: Schema.String }) {
  override get message(): string {
    return `${this.service} did not answer in time. Try again.`
  }
}

/** The file store refused or failed: a setup gap, a refused file, the store being down (runtime/files.ts). */
export class FilesError extends Schema.TaggedError<FilesError>()('FilesError', {
  message: Schema.String,
  /** The store's error code, when it gave one. */
  code: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Finite),
}) {}

/** Something about a connected account a person can act on (src/server/integrations.ts). */
export class IntegrationError extends Schema.TaggedError<IntegrationError>()('IntegrationError', {
  message: Schema.String,
  /** The provider turned the grant down: the account has to be connected again. */
  reconnect: Schema.Boolean,
}) {}

/** A secret couldn't be sealed or opened (runtime/vault.ts). The message is safe to show. */
export class VaultError extends Schema.TaggedError<VaultError>()('VaultError', {
  message: Schema.String,
}) {}

/**
 * A teammate's mailbox couldn't be used (src/server/mailbox.ts). `setup`: the
 * auth provider can't hand out tokens at all. `account`: this account needs reconnecting.
 * `api`: the provider had a bad moment. `status` is the provider's HTTP status.
 */
export class MailboxError extends Schema.TaggedError<MailboxError>()('MailboxError', {
  message: Schema.String,
  kind: Schema.Literals(['setup', 'account', 'api']),
  status: Schema.optional(Schema.Finite),
}) {}

/** The email provider refused or failed to send. The message names it ("Resend: ..."). */
export class EmailError extends Schema.TaggedError<EmailError>()('EmailError', {
  message: Schema.String,
}) {}

/** The agent engine (Swirls) refused or failed: no credential for this person, a workflow not deployed, the API down. */
export class AgentsError extends Schema.TaggedError<AgentsError>()('AgentsError', {
  message: Schema.String,
}) {}

/**
 * The app's own code (a hook, handler or setting in src/app/extensions.ts)
 * failed. Staff see what it threw. An `after` hook runs once the change is
 * kept, so its failure says so first: nobody should make the change again.
 */
export class ExtensionError extends Schema.TaggedError<ExtensionError>()('ExtensionError', {
  hook: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const said = messageOf(this.cause)
    return this.hook.startsWith('after') ? `Saved, but a step after it failed: ${said}` : said
  }
}

/** Calls the app's own code, which returns a value or a promise and may throw. */
export const fromHook = <A>(
  hook: string,
  call: () => A | PromiseLike<A>,
): Effect.Effect<Awaited<A>, ExtensionError> =>
  // The app's code calls back in through `@swirls/spools/extensions`: what it does there is
  // done with the access of whoever called it, and nothing more (access.ts).
  Effect.flatMap(Effect.all([CurrentAccess, CurrentPerson]), ([access, person]) =>
    Effect.tryPromise({
      try: async (): Promise<Awaited<A>> => await carrying(access, call, person),
      catch: (cause) => new ExtensionError({ hook, cause }),
    }),
  )

/**
 * Fails with `error` when `refused` holds, and otherwise does nothing: a check
 * before work that gives nothing back.
 */
export const failWhen = <E>(refused: boolean, error: () => E) =>
  refused ? Effect.fail(error()) : Effect.void

/** Every error a server function or route may fail with. A program that can fail with anything else doesn't compile at the boundary. */
export type StaffError =
  | Unauthorized
  | NotFound
  | Invalid
  | NotConfigured
  | DatabaseError
  | ScopeRefused
  | AuthError
  | Timeout
  | ExtensionError
  | FilesError
  | IntegrationError
  | VaultError
  | MailboxError
  | EmailError
  | AgentsError

/** The message of whatever was thrown, for errors that show a cause's own words. */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message
  }

  if (Predicate.isString(cause)) {
    return cause
  }

  return 'Something went wrong.'
}
