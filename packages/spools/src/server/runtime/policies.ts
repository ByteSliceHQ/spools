import { type Duration, Effect, Schedule } from 'effect'

import { Timeout } from './errors'

/**
 * How long the CRM waits for each outside service, and when it tries again.
 * One table, so the limits can be reviewed (and changed) in one place. Each
 * service applies its row with `withPolicy`; no call site sets its own. An
 * adapter puts its provider's name to its port's row.
 *
 * Retries are only for calls that are safe to repeat: reads, and writes that
 * carry an idempotency key. A timeout stops the CRM waiting; it does not stop
 * work already started on the other side (a Postgres query, a Swirls run).
 */
export type Policy = {
  /** The name staff see in a timeout message ("FlashDrive did not answer in time"). */
  readonly service: string
  readonly timeout: Duration.Input
  /** Extra attempts after the first. Zero for anything not safe to repeat. */
  readonly retries: number
}

export const policies = {
  /** Postgres reads. Writes have no time limit: giving up on a write leaves its outcome unknown. */
  databaseRead: { service: 'The database', timeout: '20 seconds', retries: 0 },
  /** The auth provider's directory (reading a person's account and the team). Adapters put their own name to it. */
  authUsers: { service: 'The sign-in service', timeout: '5 seconds', retries: 1 },
  /** The file store. Retries only reads and writes that are safe to repeat. */
  files: { service: 'The file store', timeout: '15 seconds', retries: 2 },
  /** OAuth token exchange and refresh with Google, Microsoft or an app's provider. Retried only when unreachable. */
  oauth: { service: 'The account provider', timeout: '10 seconds', retries: 1 },
  /** Reading Gmail, Google Calendar and Microsoft Graph, and sending through them. Reads are retried on 429/5xx. */
  mailApi: { service: 'The mail provider', timeout: '20 seconds', retries: 2 },
  /** Sending through the email provider. Retried on rate limits and server errors only when the email carries an idempotency key. */
  email: { service: 'The email provider', timeout: '10 seconds', retries: 2 },
  /** Looking up what the agent engine has (a workflow by its name). A read: retried. */
  agentsRead: { service: 'The agent engine', timeout: '10 seconds', retries: 2 },
  /** Starting a workflow, or a chat call. Not retried: a second start is a second run. */
  agentsRun: { service: 'The agent engine', timeout: '15 seconds', retries: 0 },
  /** Reading the business's own website for its tracking tags. A read: retried once. */
  website: { service: 'The website', timeout: '15 seconds', retries: 1 },
  /** Posting to a social network and reading an ad account. Only reads are retried: a second post is a second post. */
  marketingApi: { service: 'The network', timeout: '20 seconds', retries: 2 },
  /** Sealing and opening secrets. Not retried: a failure is the vault's answer. */
  vault: { service: 'The vault', timeout: '10 seconds', retries: 0 },
  /** Passing a file's bytes on to the file store (a relayed upload). A stream can't be replayed. */
  fileTransfer: { service: 'The file store', timeout: '120 seconds', retries: 0 },
} satisfies Record<string, Policy>

/**
 * Applies a policy to one outside call: retry the failures `retryable` accepts
 * (exponential backoff from 200 ms with jitter), then fail with `Timeout` if
 * the whole thing takes longer than the limit.
 */
export const withPolicy =
  <E>(policy: Policy, retryable: (error: E) => boolean = () => true) =>
  <A, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | Timeout, R> => {
    const attempts =
      policy.retries > 0
        ? self.pipe(
            Effect.retry({
              schedule: Schedule.exponential('200 millis').pipe(Schedule.jittered),
              times: policy.retries,
              while: retryable,
            }),
          )
        : self

    return attempts.pipe(
      Effect.timeoutOrElse({
        duration: policy.timeout,
        orElse: () => Effect.fail(new Timeout({ service: policy.service })),
      }),
    )
  }
