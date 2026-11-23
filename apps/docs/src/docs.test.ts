import { expect, test } from 'bun:test'

import { indexDocs } from '../scripts/index-docs'
import { renderPage } from '../scripts/markdown'
import manifest from './docs-manifest.json'

test('every page is in the menu, every link leads somewhere, and the search index is current', async () => {
  expect(await indexDocs()).toEqual(manifest)
})

test('links between docs stay on the site and links to code go to the repository', () => {
  const { html } = renderPage(
    '# Page\n\n[a](adapters.md#what-ships) [b](README.md) [c](../src/routes) [d](../.env.example) [e](https://example.com) [f](#here)',
  )

  expect([...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href)).toEqual([
    '/docs/adapters#what-ships',
    '/docs',
    'https://github.com/ByteSliceHQ/spools/tree/main/src/routes',
    'https://github.com/ByteSliceHQ/spools/blob/main/.env.example',
    'https://example.com',
    '#here',
  ])
})

test('headings get the same anchors GitHub gives them', () => {
  const { sections } = renderPage(
    '# Page\n\n## Check it\n\n### `spools gen`: what it does\n\n## Check it',
  )

  expect(sections).toEqual([
    { id: 'check-it', title: 'Check it', level: 2 },
    { id: 'spools-gen-what-it-does', title: 'spools gen: what it does', level: 3 },
    { id: 'check-it-1', title: 'Check it', level: 2 },
  ])
})

test('code is escaped', () => {
  const { html } = renderPage('# Page\n\n```html\n<script>alert("x")</script>\n```')
  expect(html).not.toContain('<script>')
  expect(html).toContain('data-code="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"')
})
