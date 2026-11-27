import { Cause, Effect, type Fiber, Schedule } from 'effect'
import { z } from 'zod'

import type { CrmCampaign } from '../crm/config-schema'
import type { Actor } from '../crm/extensions'
import { dueAt, stepAfter } from '../crm/sequences'
import { isSuppressed, renderTemplate, textToHtml, unsubscribeUrl } from './email'
import {
  addActivity,
  type CrmRecord,
  type CrmValue,
  getRecord,
  relatedRecord,
  valueText,
} from './records'
import { runtime } from './runtime/app'
import * as config from './runtime/config'
import { Email, type OutboundEmail } from './runtime/email'
import { fromHook, Invalid, messageOf, type StaffError } from './runtime/errors'
import { Sequences } from './sequences'
import { getObject, spool } from './spool'
import { asc, lte } from './store/query'
import { Store } from './store/store'
import { SequenceRun } from './store/tables'

export { durationMs } from '../crm/sequences'

/**
 * Email sequences: the `campaigns` in crm.config.json, each a few emails with
 * waits between them.
 *
 * An enrolment is one row in `sequence_runs`, saying which email is next and
 * when it is due. `tick` sends what is due and moves each row on. Nothing is
 * kept in memory or on disk, so it runs the same on a server that stays up
 * (`startSequences` ticks once a minute) and on a host that only wakes for a
 * request (a cron job calls /api/cron/sequences, which ticks).
 *
 * Two ticks at once can't send the same email: a run is taken by moving its
 * due time ahead in one conditional UPDATE, which only one of them wins. If a
 * send succeeds and the process dies before the run is moved on, the email is
 * sent again when that hold runs out, with the same idempotency key, so the
 * provider drops the repeat.
 */

type Run = NonNullable<typeof SequenceRun.row>

declare global {
  /**
   * The schedule's fiber. It lives on the global object because a dev-server
   * reload loads this module again, and must not start a second schedule.
   */
  var spoolsSequenceFiber: Fiber.Fiber<unknown, unknown> | undefined
}

/** What an email address field must at least hold. */
const address = z.string()

/** A related record's title, when it is something an email can print. */
const printableTitle = z.union([z.string(), z.number()])

/** How long a run is held while its email is being sent. A send that takes longer than this has failed. */
const HOLD_MS = 10 * 60_000
/** A send that keeps failing stops the run after this many tries, rather than retrying for ever. */
const MAX_ATTEMPTS = 5
/** Runs taken per query. A tick keeps going until nothing is due or its time is up. */
const BATCH = 25

/**
 * Send through the app's own transport (`email.send` in src/app/extensions.ts)
 * when it has one, else the `Email` service (Resend). Read on each send
 * because extensions may still be initialising when this module loads.
 */
const send = (email: OutboundEmail) => {
  const own = spool().extensions.email?.send
  return own ? fromHook('email.send', () => own(email)) : Email.use((e) => e.send(email))
}

/** Decide whether a step may send right now; re-reads the record so edits and stop conditions apply. */
const checkStep = Effect.fn('campaigns.checkStep')(function* (
  campaign: CrmCampaign,
  record: CrmRecord | null,
): Effect.fn.Return<{ to: string } | { skip: string } | { stop: string }, StaffError, Store> {
  if (!record) {
    return { stop: 'record deleted' }
  }

  for (const [field, values] of Object.entries(campaign.stopWhen)) {
    const value = valueText(record[field])

    if (values.includes(value)) {
      return { stop: `${field} is ${value}` }
    }
  }

  // These can change before the next email is due, so only this one is skipped.
  const to = address.safeParse(record[campaign.emailField]).data

  if (to === undefined || !to.includes('@')) {
    return { skip: 'no email address' }
  }

  if (yield* isSuppressed(to)) {
    return { skip: 'address is suppressed' }
  }

  return { to }
})

type Outcome = 'sent' | 'skipped' | 'stopped'

type RunChange = {
  status?: 'finished' | 'stopped'
  nextStep?: string | null
  dueAt?: Date | null
  attempts?: number
  note?: string | null
}

/** One change to a run's row. */
const update = (id: string, change: RunChange) =>
  Store.use((store) => store.update(SequenceRun, { where: { id } }, change))

const activity = (entry: Parameters<typeof addActivity>[0]) => addActivity(entry)

const over = (status: 'finished' | 'stopped', note: string | null) =>
  ({ status, nextStep: null, dueAt: null, attempts: 0, note }) as const

/**
 * A record's values as an email shows them, for `{{field}}` in a step's subject
 * and body: a related record by its title, a choice by its label, a date as a
 * date in the sequences' time zone, yes or no. Left as they are stored, a
 * relation would print as "[object Object]" and a date as JavaScript writes one.
 */
export function templateValues(
  objectKey: string,
  record: CrmRecord,
  zone?: string,
): Record<string, string> {
  const { fields } = getObject(objectKey)

  const show = (key: string, value: CrmValue): string => {
    if (value === null || value === undefined) {
      return ''
    }

    const field = Object.hasOwn(fields, key) ? fields[key] : undefined

    if (value instanceof Date) {
      // A date field holds a day, not a moment: it is the same day everywhere.
      return field?.type === 'date'
        ? new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(value)
        : new Intl.DateTimeFormat('en', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: zone,
          }).format(value)
    }

    if (field?.type === 'select') {
      return field.options.find((o) => o.value === value)?.label ?? valueText(value)
    }

    if (value === true || value === false) {
      return value ? 'yes' : 'no'
    }

    if (Array.isArray(value)) {
      // What a relations field holds, by title: "VIP, Partner".
      if (field?.type !== 'relations') {
        return ''
      }

      const titleField = getObject(field.to).titleField

      return value
        .flatMap((item) => {
          const title = printableTitle.safeParse(relatedRecord(item)?.[titleField])
          return title.success ? [String(title.data)] : []
        })
        .join(', ')
    }

    const related = relatedRecord(value)

    if (related) {
      // A related record, read with the one it belongs to.
      if (field?.type !== 'relation') {
        return ''
      }

      const title = printableTitle.safeParse(related[getObject(field.to).titleField])
      return title.success ? String(title.data) : ''
    }

    return valueText(value)
  }

  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, show(key, value)]))
}

/**
 * Send the run's next email, or skip it, and move the run on. The caller holds
 * the run. Returns what happened to this step.
 */
const runStep = Effect.fn('campaigns.runStep')(function* (run: Run, now: Date) {
  const { campaigns, hours, zone } = yield* (yield* Sequences).current

  const campaign = Object.hasOwn(campaigns, run.campaignKey)
    ? campaigns[run.campaignKey]
    : undefined

  const step = campaign?.steps.find((s) => s.id === run.nextStep)

  // The config changed under a run in flight: there is nothing left for it to send.
  if (!campaign || !step) {
    yield* update(
      run.id,
      over('stopped', campaign ? `step "${run.nextStep}" was removed` : 'sequence was removed'),
    )

    return 'stopped'
  }

  const { objectKey, recordId } = run
  const record = yield* getRecord(objectKey, recordId)
  const check = yield* checkStep(campaign, record)

  if ('stop' in check) {
    if (record) {
      yield* activity({
        objectKey,
        recordId,
        kind: 'campaign',
        summary: `stopped ${campaign.label} before "${step.id}" (${check.stop})`,
        actor: 'Sequence',
      })
    }

    yield* update(run.id, over('stopped', check.stop))
    return 'stopped'
  }

  let outcome: Outcome = 'skipped'

  if ('skip' in check) {
    yield* activity({
      objectKey,
      recordId,
      kind: 'campaign',
      summary: `skipped "${step.id}" of ${campaign.label} (${check.skip})`,
      actor: 'Sequence',
    })
  } else {
    const unsubscribe = yield* unsubscribeUrl(check.to)

    // A run whose record is gone stopped above, so the record is always here.
    const values: Record<string, string> = record ? templateValues(objectKey, record, zone) : {}
    values['unsubscribeUrl'] = unsubscribe

    const subject = renderTemplate(step.subject, values)

    const result = yield* send({
      to: check.to,
      subject,
      text: `${renderTemplate(step.body, values)}\n\nUnsubscribe: ${unsubscribe}`,
      html: textToHtml(renderTemplate(step.body, values), unsubscribe),
      headers: {
        'List-Unsubscribe': `<${unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      // The same for every try at this step of this run, so a repeat after a crash is dropped by the provider.
      idempotencyKey: `sequence-${run.id}-${step.id}`,
    })

    yield* activity({
      objectKey,
      recordId,
      kind: 'email',
      summary: `${result.sent ? 'sent' : 'logged (email not configured)'} "${subject}" from ${campaign.label}`,
      body: renderTemplate(step.body, values),
      actor: 'Sequence',
      outcome: result.sent ? 'sent' : 'not_sent',
    })

    outcome = 'sent'
  }

  const next = stepAfter(campaign.steps, step.id)

  yield* update(
    run.id,
    next
      ? { nextStep: next.id, dueAt: dueAt(next, now, hours, zone), attempts: 0, note: null }
      : over('finished', null),
  )

  return outcome
})

/**
 * Hold a run so that only this caller sends its next email: move its due time
 * ahead, but only if it still is what was read. The store checks and changes
 * in one step, so of two ticks that read the same row exactly one gets it.
 */
const hold = Effect.fn('campaigns.hold')(function* (id: string, was: Date, until: Date) {
  const store = yield* Store
  return (
    (yield* store.update(
      SequenceRun,
      { where: { id, status: 'active', dueAt: was } },
      { dueAt: until },
    )) === 1
  )
})

/**
 * Take a due run and deal with its next step. Returns null when another tick
 * took it first. A failed send leaves the run held, to be tried again later.
 */
const take = Effect.fn('campaigns.take')(function* (run: Run, now: Date) {
  if (!run.dueAt) {
    return null
  }

  const until = new Date(now.getTime() + HOLD_MS)

  if (!(yield* hold(run.id, run.dueAt, until))) {
    return null
  }

  const held: Run = { ...run, dueAt: until }
  return yield* runStep(held, now).pipe(
    Effect.map((outcome): Outcome | 'failed' => outcome),
    // Whatever went wrong (the provider, the database, a bug), the run is kept, tried again, and given up on in the end.
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause)
      }

      const message = messageOf(Cause.squash(cause))
      const attempts = held.attempts + 1
      return Effect.gen(function* () {
        yield* Effect.logError(
          `[sequences] "${held.nextStep}" of ${held.campaignKey} failed (try ${attempts})`,
          Cause.pretty(cause),
        )

        if (attempts < MAX_ATTEMPTS) {
          yield* update(held.id, { attempts, note: message })
          return 'failed' as const
        }

        yield* update(held.id, over('stopped', `gave up after ${attempts} tries: ${message}`))

        const label =
          (yield* (yield* Sequences).current).campaigns[held.campaignKey]?.label ?? held.campaignKey

        yield* activity({
          objectKey: held.objectKey,
          recordId: held.recordId,
          kind: 'campaign',
          summary: `stopped ${label}: an email could not be sent after ${attempts} tries`,
          actor: 'Sequence',
        }).pipe(Effect.ignore)

        return 'stopped' as const
      })
    }),
  )
})

export type TickResult = {
  sent: number
  skipped: number
  stopped: number
  failed: number
  /** Time ran out with emails still due: the next tick carries on. */
  more: boolean
}

/**
 * Send every email that is due. Safe to call from several places at once, and
 * as often as you like. `budgetMs` stops it before a serverless function's time
 * limit; what is left waits for the next call.
 */
export const tick = Effect.fn('campaigns.tick')(function* (
  opts: { now?: Date; budgetMs?: number } = {},
) {
  const started = Date.now()
  const result: TickResult = { sent: 0, skipped: 0, stopped: 0, failed: 0, more: false }

  if (Object.keys((yield* (yield* Sequences).current).campaigns).length === 0) {
    return result
  }

  const store = yield* Store

  for (;;) {
    const now = opts.now ?? new Date()

    const due = yield* store.find(SequenceRun, {
      where: { status: 'active' },
      filter: lte('dueAt', now),
      order: [asc('dueAt')],
      limit: BATCH,
    })

    if (due.length === 0) {
      return result
    }

    let took = 0

    for (const run of due) {
      if (opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs) {
        result.more = true
        return result
      }

      const outcome = yield* take(run, now)

      if (!outcome) {
        continue
      }

      took++
      result[outcome]++
    }

    // Every run in the batch went to another tick: it is dealing with them.
    if (took === 0) {
      return result
    }
  }
})

export const enroll = Effect.fn('campaigns.enroll')(function* (
  campaignKey: string,
  objectKey: string,
  record: CrmRecord,
  actor: Actor,
) {
  const { campaigns, hours, zone } = yield* (yield* Sequences).current
  const campaign = Object.hasOwn(campaigns, campaignKey) ? campaigns[campaignKey] : undefined
  const opening = campaign?.steps[0]

  if (!campaign || !opening) {
    return yield* new Invalid({ message: `Unknown campaign "${campaignKey}"` })
  }

  if (campaign.object !== objectKey) {
    return yield* new Invalid({
      message: `Campaign "${campaignKey}" enrolls ${campaign.object}, not ${objectKey}`,
    })
  }

  // One enrolment per record per campaign, for good: a finished run still counts.
  const store = yield* Store
  const where = { campaignKey, objectKey, recordId: record.id }
  const find = store.first(SequenceRun, { where })
  const existing = yield* find

  if (existing) {
    return { message: `Already enrolled in ${campaign.label}`, runId: existing.id }
  }

  const now = new Date()

  const created = yield* store
    .insert(SequenceRun, {
      ...where,
      status: 'active',
      nextStep: opening.id,
      dueAt: dueAt(opening, now, hours, zone),
      enrolledBy: actor?.id ?? null,
    })
    .pipe(
      Effect.map((run) => ({ run, other: null })),
      // Two clicks at once: the unique index kept one enrolment.
      Effect.catchTag('DatabaseError', (error) =>
        Effect.flatMap(find, (other) =>
          other ? Effect.succeed({ run: null, other }) : Effect.fail(error),
        ),
      ),
    )

  if (created.other) {
    return { message: `Already enrolled in ${campaign.label}`, runId: created.other.id }
  }

  const run = created.run

  yield* activity({
    objectKey,
    recordId: record.id,
    kind: 'campaign',
    summary: `enrolled this record in ${campaign.label} (${campaign.steps.length} emails)`,
    actor: actor?.name ?? actor?.email ?? 'System',
  })

  // An email with no wait goes now, in this request, not at the next tick. If it
  // fails, the enrolment stands and a tick tries again: whoever pressed the button is told.
  const first = run.dueAt && run.dueAt.getTime() <= now.getTime() ? yield* take(run, now) : null

  const message =
    first === 'failed'
      ? `Enrolled in ${campaign.label}, but the first email could not be sent. It will be tried again in a few minutes.`
      : `Enrolled in ${campaign.label}`

  return { message, runId: run.id }
})

/** How many records are part-way through each sequence, for the Workflows page. */
export const activeRuns = Effect.fn('campaigns.activeRuns')(function* () {
  const store = yield* Store
  const counts: Record<string, number> = {}

  for (const run of yield* store.find(SequenceRun, { where: { status: 'active' }, limit: 5000 })) {
    counts[run.campaignKey] = (counts[run.campaignKey] ?? 0) + 1
  }

  return counts
})

/**
 * Whether anything will call `tick` on this server. A server that stays up
 * ticks itself. A serverless host (SERVERLESS=1, or Vercel) needs a cron job calling /api/cron/sequences,
 * which needs CRON_SECRET; without it only emails with no wait are ever sent.
 */
export function sequencesTick(env: Record<string, string | undefined>): boolean {
  return !config.isServerless(env) || (env['CRON_SECRET']?.length ?? 0) >= 16
}

/** The built-in schedule: a tick now, for what fell due while the server was down, then once a minute. */
export const sequenceSchedule = tick({ budgetMs: 50_000 }).pipe(
  Effect.catchCause((cause) => Effect.logError('[sequences] tick failed', Cause.pretty(cause))),
  Effect.repeat(Schedule.spaced('1 minute')),
)

/**
 * Start ticking once a minute. Called once when the server boots; a second call
 * (a dev-server reload) is a no-op. On a serverless host there is no process to
 * keep a timer in: a cron job calls /api/cron/sequences instead (docs/campaigns.md).
 */
export const startSequences = Effect.fn('campaigns.startSequences')(function* () {
  if (yield* config.serverless) {
    return
  }

  if (Object.keys((yield* (yield* Sequences).current).campaigns).length === 0) {
    return
  }

  if (globalThis.spoolsSequenceFiber) {
    return
  }

  globalThis.spoolsSequenceFiber = runtime().runFork(sequenceSchedule)
})
