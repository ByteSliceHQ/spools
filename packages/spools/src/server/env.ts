import type { Env, Feature, Requirement } from './runtime/adapter'
import { features } from './runtime/config'
import { adaptersOf, spool } from './spool'

/**
 * Environment contract. What the Spool's adapters require fails fast at boot in
 * production; optional variables switch features on and are reported once at
 * startup. An adapter declares its own (runtime/adapter.ts); the framework's
 * are in runtime/config.ts.
 */

let logged = false

/** What is wrong with the environment for these requirements, one line each. */
export function environmentProblems(requirements: readonly Requirement[], env: Env): string[] {
  return requirements.flatMap(({ name, or = [], check }) => {
    const set = [name, ...or].find((n) => env[n])

    if (!set) {
      return [`${name} is not set`]
    }

    const problem = check?.(env[set] ?? '')
    return problem ? [`${set} ${problem}`] : []
  })
}

export function logEnvironment(env: Env = process.env): void {
  if (logged) {
    return
  }

  logged = true

  const adapters = adaptersOf(spool())
  console.info(`[spool] ${adapters.map((a) => a.id).join(', ')}`)

  const problems = environmentProblems(
    adapters.flatMap((a) => a.requires ?? []),
    env,
  )

  if (problems.length > 0) {
    const message = `Missing or invalid environment:\n  ${problems.join('\n  ')}\nSee .env.example.`

    if (env['NODE_ENV'] === 'production') {
      throw new Error(message)
    }

    console.warn(`\n[env] ${message}\n`)
  }

  const optional: Feature[] = [...adapters.flatMap((a) => a.features ?? []), ...features]

  for (const f of optional) {
    const missing = f.vars.filter((v) => !env[v])
    const problem = missing.length === 0 ? f.check?.(env) : null

    if (missing.length > 0) {
      console.info(`[env] ${f.name}: off (set ${missing.join(', ')})`)
    } else if (problem) {
      console.warn(`[env] ${f.name}: ${problem}`)
    } else {
      console.info(`[env] ${f.name}: on`)
    }
  }

  // On unless switched off, so it is reported the other way round.
  if (env['CRM_GUIDES'] === 'off') {
    console.info('[env] Guides: not offered (CRM_GUIDES=off); Help still lists them')
  }
}
