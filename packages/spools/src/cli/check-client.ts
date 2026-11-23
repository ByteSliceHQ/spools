/**
 * Fails the build if Effect reached the browser bundle. Effect is server-only
 * (docs/server-code.md): lint refuses an `effect` import in browser code, and
 * this catches one that arrives some other way (through a shared module, or a
 * server function the compiler didn't split out). Run after `vite build`.
 *
 * It looks for Effect's internal type ids (`~effect/...`), which survive
 * minification.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'dist/client')

if (!existsSync(dir)) {
  console.error('[client bundle] dist/client is missing. Run the build first.')
  process.exit(1)
}

const offenders: string[] = []
let scanned = 0

for (const file of new Bun.Glob('**/*.{js,mjs}').scanSync({ cwd: dir })) {
  scanned++

  if ((await Bun.file(join(dir, file)).text()).includes('~effect/')) {
    offenders.push(join(dir, file))
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
