/**
 * Fails the build if Effect reached the browser bundle. Effect is server-only
 * (docs/server-code.md): lint refuses an `effect` import in browser code, and
 * this catches one that arrives some other way (through a shared module, or a
 * server function the compiler didn't split out). Run after `vite build`.
 *
 * It looks for Effect's internal type ids (`~effect/...`), which survive
 * minification, in every build it finds: `dist/client`, and `.vercel/output/static`
 * for a Vercel build. Name folders to check those instead:
 *
 *   spools check-client build/public
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BUILDS = ['dist/client', '.vercel/output/static']

const root = process.cwd()
const named = process.argv.slice(2)
const missing = named.filter((dir) => !existsSync(resolve(root, dir)))

if (missing.length > 0) {
  console.error(`[client bundle] ${missing.join(', ')} is missing. Run the build first.`)
  process.exit(1)
}

const dirs = (named.length > 0 ? named : BUILDS.filter((dir) => existsSync(join(root, dir)))).map(
  (dir) => resolve(root, dir),
)

if (dirs.length === 0) {
  console.error(`[client bundle] no build found (${BUILDS.join(' or ')}). Run the build first.`)

  process.exit(1)
}

const offenders: string[] = []
let scanned = 0

for (const dir of dirs) {
  for (const file of new Bun.Glob('**/*.{js,mjs}').scanSync({ cwd: dir })) {
    scanned++

    if ((await Bun.file(join(dir, file)).text()).includes('~effect/')) {
      offenders.push(join(dir, file))
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `[client bundle] Effect reached the browser in:\n  ${offenders.join('\n  ')}\n` +
      'Browser code must not import effect or src/server/runtime; call a server function instead.',
  )

  process.exit(1)
}

console.log(`[client bundle] no Effect in ${scanned} browser files`)
