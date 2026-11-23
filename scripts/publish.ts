import { join, resolve } from 'node:path'

/**
 * Publishes the packages whose versions npm doesn't have yet. Run by the release
 * workflow; the commit is verified and the packed packages are tried out first.
 */

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stderr: 'inherit',
    // Forward stdout so changesets/action can parse `New tag:` lines and
    // push git tags / create GitHub releases.
    stdout: 'inherit',
  })

  const exitCode = await child.exited

  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${exitCode}`)
  }
}

const root = resolve(import.meta.dirname, '..')

async function isPublished(directory: string): Promise<boolean> {
  const { name, version } = await Bun.file(join(root, directory, 'package.json')).json()
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  const { ok } = await fetch(url, { method: 'HEAD' })
  console.log(`${name}@${version} is ${ok ? 'already' : 'not yet'} on npm`)
  return ok
}

const published = await Promise.all(['packages/spools', 'packages/create-spools'].map(isPublished))

if (published.every(Boolean)) {
  // `changeset publish` skips already-published versions and does not create
  // tags. `changeset tag` still emits `New tag:` for missing tags so the
  // action can push them and open the GitHub release.
  await run(['bun', 'x', 'changeset', 'tag'], root)
  process.exit(0)
}

// Nothing is published from a commit that doesn't pass: this workflow runs beside CI, not after it.
await run(['bun', 'run', 'verify'], root)
// Builds packages/spools/dist, which is what is published, and tries it out.
await run(['bun', 'run', 'check:package'], root)
await run(['bun', 'x', 'changeset', 'publish'], root)
