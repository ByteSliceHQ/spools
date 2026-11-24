import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { docsDirectory } from '../scripts/markdown'
import wrangler from '../wrangler.json'
import { agentPrompt, promptUrl, siteUrl } from './site'

const root = join(import.meta.dirname, '../../..')
const prompt = await Bun.file(join(import.meta.dirname, '../public/prompt.md')).text()

test('the prompt people copy names a page the site serves', () => {
  const { host, pathname } = new URL(promptUrl)

  expect(agentPrompt).toContain(promptUrl)
  expect(wrangler.routes.map((route) => route.pattern)).toContain(host)
  expect(existsSync(join(import.meta.dirname, '../public', pathname))).toBe(true)
})

test('every command in the prompt is one a new Spool has', async () => {
  const starter = await Bun.file(join(root, 'apps/starter/package.json')).json()
  const guide = await Bun.file(join(root, 'packages/create-spools/overrides/AGENTS.md')).text()
  const scripts = [...prompt.matchAll(/bun run ([\w:-]+)/g)].map(([, script = '']) => script)

  expect(scripts.length).toBeGreaterThan(0)

  for (const script of new Set(scripts)) {
    // `check` is added to a new Spool by the scaffolder; its guide for agents names it.
    expect(script in starter.scripts || guide.includes(`bun run ${script}`)).toBe(true)
  }
})

test('every option in the prompt is one the scaffolder takes', async () => {
  const scaffolder = await Bun.file(join(root, 'packages/create-spools/src/main.ts')).text()
  // `bun --version` is Bun's own.
  const options = [...prompt.matchAll(/(?<!bun )--([a-z-]+)/g)].map(([, option]) => option)

  expect(new Set(options)).toEqual(new Set(['yes', 'name', 'domain', 'email']))

  for (const option of options) {
    expect(scaffolder).toContain(`--${option}`)
  }
})

test('every link in the prompt to the docs leads to a page and a heading', async () => {
  const links = [...prompt.matchAll(/\]\((https:\/\/spools\.codes[^)]*)\)/g)].map(
    ([, href]) => href,
  )

  expect(links.length).toBeGreaterThan(0)

  for (const href of links) {
    const { origin, pathname, hash } = new URL(href ?? '')
    const slug = pathname.match(/^\/docs\/([\w-]+)$/)?.[1]
    const file = join(docsDirectory, `${slug}.md`)

    expect(origin).toBe(siteUrl)
    expect(existsSync(file)).toBe(true)

    if (hash) {
      const { renderPage } = await import('../scripts/markdown')
      const { sections } = renderPage(await Bun.file(file).text())
      expect(sections.map((section) => `#${section.id}`)).toContain(hash)
    }
  }
})
