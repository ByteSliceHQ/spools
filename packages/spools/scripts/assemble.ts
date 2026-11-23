#!/usr/bin/env bun
/**
 * Builds `dist/`, the package as it is published: compiled JavaScript,
 * declarations and styles, with a package.json whose entry points lead to them.
 *
 * In this repository `@swirls/spools` is its source, so a change shows at once.
 * What npm gets is this folder (`publishConfig.directory`).
 */
import { existsSync } from 'node:fs'
import { chmod, cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import { $ } from 'bun'

const root = join(import.meta.dir, '..')
const repository = join(root, '../..')
const compiled = join(root, '.build')
const output = join(root, 'dist')

type Entry = string | { types: string; default: string }

/** Where an entry point's source ends up: ./src/server/*.ts is ./server/*.js and its types. */
function published(source: string): Entry {
  const path = source.replace(/^\.\/src\//, './')

  if (!/\.tsx?$/.test(path)) {
    return path
  }

  const name = path.replace(/\.tsx?$/, '')
  return { types: `${name}.d.ts`, default: `${name}.js` }
}

/** Relative imports name the file they mean, which browsers and Node need. */
function withExtension(file: string, specifier: string) {
  if (['.js', '.json', '.css'].includes(extname(specifier))) {
    return specifier
  }

  const target = join(dirname(file), specifier)

  if (existsSync(`${target}.js`) || existsSync(`${target}.d.ts`)) {
    return `${specifier}.js`
  }

  if (existsSync(join(target, 'index.js'))) {
    return `${specifier}/index.js`
  }

  throw new Error(`${file} imports ${specifier}, which was not built`)
}

const relative = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g

async function rewriteImports(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)

    if (!entry.isFile() || !/\.(js|d\.ts)$/.test(entry.name)) {
      continue
    }

    const contents = await readFile(path, 'utf8')

    await writeFile(
      path,
      contents.replace(
        relative,
        (_match, before: string, quote: string, specifier: string) =>
          `${before}${quote}${withExtension(path, specifier)}${quote}`,
      ),
    )
  }
}

await rm(compiled, { recursive: true, force: true })
await rm(output, { recursive: true, force: true })
await $`bunx tsc -p tsconfig.build.json`.cwd(root)
await cp(join(compiled, 'packages/spools/src'), output, { recursive: true })
await rm(compiled, { recursive: true, force: true })
await rewriteImports(output)

// The styles name the files Tailwind reads classes from: the built ones, here.
const styles = await readFile(join(root, 'src/crm/ui/theme.css'), 'utf8')
const builtStyles = styles.replace('*.{ts,tsx}', '*.js')

if (builtStyles === styles) {
  throw new Error('theme.css has no @source this script knows how to rewrite')
}

await writeFile(join(output, 'crm/ui/theme.css'), builtStyles)

const manifest = await Bun.file(join(root, 'package.json')).json()
const { directory: _directory, ...publishConfig } = manifest.publishConfig
const { scripts: _scripts, devDependencies: _devDependencies, files: _files, ...kept } = manifest

await writeFile(
  join(output, 'package.json'),
  `${JSON.stringify(
    {
      ...kept,
      sideEffects: ['./crm/ui/theme.css', './cli/*.js'],
      bin: { spools: './cli/main.js' },
      publishConfig,
      exports: Object.fromEntries(
        Object.entries<string>(manifest.exports).map(([entry, source]) => [
          entry,
          published(source),
        ]),
      ),
    },
    null,
    2,
  )}\n`,
)

await chmod(join(output, 'cli/main.js'), 0o755)
await cp(join(root, 'README.md'), join(output, 'README.md'))
await cp(join(repository, 'LICENSE'), join(output, 'LICENSE'))
await cp(join(repository, 'NOTICE'), join(output, 'NOTICE'))

if (existsSync(join(root, 'CHANGELOG.md'))) {
  await cp(join(root, 'CHANGELOG.md'), join(output, 'CHANGELOG.md'))
}

console.log(`✓ @swirls/spools ${manifest.version} in dist`)
