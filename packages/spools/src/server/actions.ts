import { Cause, Effect } from 'effect'

import type { RunContext, RunResult, RunTargetHandler } from '../crm/extensions'
import { enroll } from './campaigns'
import { addActivity } from './records'
import { Agents } from './runtime/agents'
import { runServer } from './runtime/app'
import { fromHook, Invalid } from './runtime/errors'
import { crmConfig, spool } from './spool'

export type { RunContext, RunResult } from '../crm/extensions'

/** A deployed workflow of the agent engine, by name. Input: { objectKey, record, actor, trigger }. */
const startWorkflow = Effect.fn('actions.startWorkflow')(function* (name: string, ctx: RunContext) {
  const agents = yield* Agents

  const res = yield* agents.executeWorkflow(name, {
    objectKey: ctx.objectKey,
    record: ctx.record,
    actor: ctx.actor,
    trigger: ctx.trigger,
  })

  const message = res.skipped
    ? `Workflow "${name}" skipped (${res.reason})`
    : `Started workflow "${name}"`

  yield* addActivity({
    objectKey: ctx.objectKey,
    recordId: ctx.record.id,
    kind: 'workflow',
    summary: res.skipped ? `skipped workflow ${name} (${res.reason})` : `started workflow ${name}`,
    actor: 'Swirls',
  })

  return { message } satisfies RunResult
})

/**
 * Run targets: what a config `"run": "<kind>:<name>"` does. Built-in kinds are
 * below; extensions add more through `runTargets` in src/app/extensions.ts.
 * Each handler is a promise (the shape an app writes); the built-in ones run
 * their Effect versions on the server's runtime.
 */
const builtIn = {
  swirls: { run: (name, ctx) => runServer(startWorkflow(name, ctx)) },

  /** Enroll the record in a campaign from `campaigns` in the config. */
  campaign: {
    validate: (name) =>
      Object.hasOwn(crmConfig().campaigns, name) ? null : `unknown campaign "${name}"`,
    run: (name, ctx) => runServer(enroll(name, ctx.objectKey, ctx.record, ctx.actor)),
  },

  /** A handler from `handlers` in src/app/extensions.ts. */
  local: {
    validate: (name) =>
      Object.hasOwn(spool().extensions.handlers ?? {}, name)
        ? null
        : `no handler "${name}" in src/app/extensions.ts`,
    run: (name, ctx) => {
      const handlers = spool().extensions.handlers ?? {}
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined

      if (!handler) {
        return Promise.reject(
          new Invalid({ message: `No handler "${name}" in src/app/extensions.ts` }),
        )
      }

      return handler(ctx)
    },
  },
} satisfies Record<string, RunTargetHandler>

/** The built-in kinds, then the app's own: an app's kind of the same name replaces the built-in one. */
const registry = () =>
  Object.fromEntries<RunTargetHandler>([
    ...Object.entries(builtIn),
    ...Object.entries(spool().extensions.runTargets ?? {}),
  ])

/** The handler for a `"<kind>:<name>"` target, or what is wrong with it. */
function resolve(
  target: string,
): { handler: RunTargetHandler; name: string } | { problem: string } {
  const sep = target.indexOf(':')
  const kind = target.slice(0, sep)
  const kinds = registry()
  const handler = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined

  if (!handler) {
    return {
      problem: `Unknown run target kind "${kind}" in "${target}". Known kinds: ${Object.keys(kinds).join(', ')}`,
    }
  }

  return { handler, name: target.slice(sep + 1) }
}

/** Run a target. Its handler's failure is an `ExtensionError` with the handler's own words. */
export const runTarget = Effect.fn('actions.runTarget')(function* (
  target: string,
  ctx: RunContext,
) {
  const found = resolve(target)

  if ('problem' in found) {
    return yield* new Invalid({ message: found.problem })
  }

  const { handler, name } = found
  return yield* fromHook(`run target ${target}`, () => handler.run(name, ctx))
})

/**
 * Check that every `run` in the config resolves to a known kind and name.
 * Returns human-readable problems; empty means valid. Run by crm:gen and at start-up.
 */
export function validateRunTargets(): string[] {
  const problems: string[] = []

  const check = (where: string, target: string) => {
    const found = resolve(target)
    const problem = 'problem' in found ? found.problem : found.handler.validate?.(found.name)

    if (problem) {
      problems.push(`${where}: ${problem}`)
    }
  }

  for (const [objectKey, obj] of Object.entries(crmConfig().objects)) {
    for (const action of obj.actions) {
      check(`objects.${objectKey}.actions.${action.id}`, action.run)
    }
  }

  for (const [i, automation] of crmConfig().automations.entries()) {
    check(`automations[${i}]`, automation.run)
  }

  return problems
}

/** Fire automations for a record event. Failures are logged, never passed to the caller. */
export const fireAutomations = Effect.fn('actions.fireAutomations')(function* (
  event: 'created' | 'updated' | 'deleted',
  ctx: Omit<RunContext, 'trigger'>,
) {
  const on = `${ctx.objectKey}.${event}`
  const matches = crmConfig().automations.filter((a) => a.on === on)

  yield* Effect.forEach(
    matches,
    (a) =>
      runTarget(a.run, { ...ctx, trigger: on }).pipe(
        // Being interrupted is not a failure to log: it goes on to the caller.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError(`[automation] ${on} -> ${a.run} failed`, Cause.pretty(cause)),
        ),
      ),
    { concurrency: 'unbounded', discard: true },
  )
})
