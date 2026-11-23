import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { docsNav, isDocsNavGroup, type DocsNavItem, type DocsNavLink } from '../src/nav'
import { repositoryUrl } from '../src/site'
import { docsDirectory, plain, readPage } from './markdown'

export type IndexedPage = {
  path: string
  title: string
  description: string
  sections: { id: string; title: string; level: number }[]
  text: string
}

const introduction = 'README'

/** Every page in reading order, checked: no page missing from the menu, no link to nothing. */
export async function indexDocs(): Promise<IndexedPage[]> {
  const listed = docsNav
    .flatMap((item: DocsNavItem): readonly DocsNavLink[] =>
      isDocsNavGroup(item) ? item.children : [item],
    )
    .map(({ to }) => (to === '/docs' ? introduction : to.replace('/docs/', '')))

  const written = (await readdir(docsDirectory))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''))

  const problems = [
    ...written
      .filter((slug) => !listed.includes(slug))
      .map((slug) => `docs/${slug}.md is not in src/nav.ts`),
    ...listed
      .filter((slug) => !written.includes(slug))
      .map((slug) => `src/nav.ts lists docs/${slug}.md, which does not exist`),
  ]

  const pages = await Promise.all(
    listed
      .filter((slug) => written.includes(slug))
      .map(async (slug) => ({
        slug,
        path: slug === introduction ? '/docs' : `/docs/${slug}`,
        ...(await readPage(slug)),
      })),
  )

  const anchors = new Map(
    pages.map((page) => [page.path, new Set(page.sections.map((section) => section.id))]),
  )

  for (const page of pages) {
    for (const [, href = ''] of page.html.matchAll(/<a href="(\/docs[^"]*|#[^"]*)"/g)) {
      const [path = '', hash] = href.split('#')
      const known = anchors.get(path || page.path)

      if (!known) {
        problems.push(`docs/${page.slug}.md links to ${path}, which does not exist`)
      } else if (hash && !known.has(hash)) {
        problems.push(`docs/${page.slug}.md links to ${href}, which has no such heading`)
      }
    }
  }

  const inRepository = new RegExp(`<a href="${repositoryUrl}/(?:blob|tree)/main/([^"#]+)`, 'g')

  for (const page of pages) {
    for (const [, path = ''] of page.html.matchAll(inRepository)) {
      if (!existsSync(join(docsDirectory, '..', path))) {
        problems.push(`docs/${page.slug}.md links to ${path}, which does not exist`)
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join('\n'))
  }

  return pages.map(({ path, title, description, sections, html }) => ({
    path,
    title,
    description,
    sections,
    text: plain(html.replace(/<div class="not-prose[\s\S]*?<\/pre>\s*<\/div>/g, ' ')),
  }))
}

if (import.meta.main) {
  const pages = await indexDocs()

  await Bun.write(
    join(import.meta.dir, '../src/docs-manifest.json'),
    `${JSON.stringify(pages, null, 2)}\n`,
  )

  console.log(`Indexed ${pages.length} pages`)
}
