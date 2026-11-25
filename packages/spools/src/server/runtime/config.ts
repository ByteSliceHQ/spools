import { Config, Effect, Option, Redacted } from 'effect'

import { atLeast, type Env, type Feature } from './adapter'

/**
 * Every environment variable the server reads, declared once.
 *
 * Server code reads a variable with `yield* config.cronSecret` (an Effect
 * `Config`), never `process.env`: tests then set values with a
 * `ConfigProvider` layer instead of changing the process. Secrets are
 * `Config.Redacted`, so they never print in a log. Values are read from the
 * environment each time (runtime/app.ts), as `process.env` was before.
 *
 * `features` below, and each adapter's own, drive the boot report
 * (`[env] Files on records: on`) in env.ts. When you add a variable, add it
 * here, and to `features` if it switches something on.
 */

/** Bearer secret for /api/cron/*. Unset or under 16 characters means the cron routes refuse every call. */
export const cronSecret = Config.option(Config.Redacted('CRON_SECRET'))

/** `CRM_GUIDES=off` stops guides being offered (the Help menu still lists them). */
export const guidesOffered = Config.String('CRM_GUIDES').pipe(
  Config.withDefault('on'),
  Config.map((value) => value !== 'off'),
)

/**
 * One variable by a name only known at run time (an app's integration names
 * its own client id variable), or undefined when unset or empty.
 */
export const variable = (name: string): Effect.Effect<string | undefined> =>
  Effect.map(
    read(Config.option(Config.String(name))),
    (value) => Option.getOrUndefined(value)?.trim() || undefined,
  )

/** Whether a value switches something on: "1" or "true". Anything else, "0" and "false" included, is off. */
export const isOn = (value: string | undefined): boolean => /^(1|true)$/i.test(value?.trim() ?? '')

/**
 * Whether the host has no long-lived process, so nothing here can keep a timer or a disk.
 * `SERVERLESS=1` says so on any host. Vercel says so itself (it sets `VERCEL` in every
 * build and function), so a Spool deployed there needs no switch.
 */
export const isServerless = (env: Env): boolean =>
  isOn(env['SERVERLESS']) || Boolean(env['VERCEL']?.trim())

/** `isServerless` for this server's own environment. */
export const serverless: Effect.Effect<boolean> = Effect.suspend(() =>
  Effect.map(Effect.all([variable('SERVERLESS'), variable('VERCEL')]), ([SERVERLESS, VERCEL]) =>
    isServerless({ SERVERLESS, VERCEL }),
  ),
)

/** Every variable, for code that hands the environment to the app (an integration's URL builder). */
export const environment: Effect.Effect<Record<string, string | undefined>> = Effect.sync(() => ({
  ...process.env,
}))

/** The value of an optional secret, or undefined. For code that hands it to a library. */
export const reveal = (secret: Option.Option<Redacted.Redacted>): string | undefined =>
  Option.getOrUndefined(Option.map(secret, Redacted.value))

/** Reads a config value; a missing or malformed variable is a bug in the deployment, not something staff can fix. */
export const read = <A>(config: Config.Config<A>): Effect.Effect<A> => Effect.orDie(config)

/** A deployment whose `APP_URL` is still the one from .env.example sends links nobody else can open. */
export const localAddress = (env: Env): string | null =>
  env['NODE_ENV'] === 'production' &&
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(env['APP_URL'] ?? '')
    ? "APP_URL is this machine's own address, so links in email won't open for anyone else. Set it to the CRM's public address"
    : null

export const features: Feature[] = [
  {
    name: 'Swirls tool API (/api/swirls)',
    vars: ['SWIRLS_APP_TOKEN'],
    check: atLeast('SWIRLS_APP_TOKEN', 32),
  },
  {
    name: 'Unsubscribe links',
    vars: ['APP_URL', 'APP_SECRET'],
    check: (env) => atLeast('APP_SECRET', 32)(env) ?? localAddress(env),
  },
  {
    name: 'Integrations: connect a Google mailbox',
    vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  {
    name: 'Integrations: connect a Microsoft mailbox',
    vars: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  },
  {
    name: 'Cron routes (/api/cron/mail-sync, /api/cron/sequences, /api/cron/warm)',
    vars: ['CRON_SECRET'],
    check: atLeast('CRON_SECRET', 16),
  },
]
