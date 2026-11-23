import { readFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'

import GithubSlugger from 'github-slugger'
import { Marked } from 'marked'
import type { Plugin } from 'vite'

import { highlightCode } from '../src/components/code-highlight'
import type { Page, Section } from '../src/docs'
import { repositoryUrl } from '../src/site'

export const docsDirectory = join(import.meta.dirname, '../../../docs')

const entities = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
])

function escape(text: string) {
  return text.replace(/[&<>"]/g, (character) => entities.get(character) ?? character)
}

/** What a reader sees of some HTML, for the search index and page descriptions. */
export function plain(html: string) {
  return html
    .replace(/<a class="heading-anchor".*?<\/a>/gs, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:)])/g, '$1')
    .trim()
}

/** Docs link to each other and to files in the repository; both have a place on the site. */
function resolveLink(href: string) {
  if (/^([a-z]+:|#)/i.test(href)) {
    return href
  }

  const [path = '', hash] = href.split('#')
  const target = posix.normalize(posix.join('docs', path))
  const page = target.match(/^docs\/([\w-]+)\.md$/)?.[1]
  const suffix = hash ? `#${hash}` : ''

  if (page) {
    return `${page === 'README' ? '/docs' : `/docs/${page}`}${suffix}`
  }

  return `${repositoryUrl}/${posix.extname(target) ? 'blob' : 'tree'}/main/${target}${suffix}`
}

function codeBlock(code: string, lang: string) {
  return `<div class="not-prose mt-6 mb-8 max-w-full min-w-0 [&_pre]:m-0! [&_pre]:rounded-t-none!">
<div class="border-line bg-background-subtle text-muted flex items-center justify-between rounded-t-md border border-b-0 px-[0.8rem] py-[0.45rem] font-mono text-xs">
<span>${escape(lang)}</span>
<button type="button" class="border-line text-foreground cursor-pointer rounded-sm border px-2 py-1" aria-label="Copy code" data-code="${escape(code)}">Copy</button>
</div>
${highlightCode(code, lang)}
</div>\n`
}

export function renderPage(source: string): Page {
  const slugger = new GithubSlugger()
  const sections: Section[] = []

  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens)
        const title = plain(html)

        if (depth === 1) {
          return `<h1>${html}</h1>\n`
        }

        const id = slugger.slug(title)
        sections.push({ id, title, level: depth })

        return `<h${depth} id="${id}">${html}<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`
      },
      code({ text, lang }) {
        return codeBlock(text, lang?.split(' ')[0] || 'text')
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens)
        return `<a href="${escape(resolveLink(href))}"${title ? ` title="${escape(title)}"` : ''}>${label}</a>`
      },
    },
  })

  const html = marked.parse(source, { async: false })

  return {
    title: plain(html.match(/<h1>(.*?)<\/h1>/s)?.[1] ?? 'Documentation'),
    description: plain(html.match(/<p>(.*?)<\/p>/s)?.[1] ?? ''),
    sections,
    html,
  }
}

export async function readPage(slug: string) {
  return renderPage(await readFile(join(docsDirectory, `${slug}.md`), 'utf8'))
}

/** Lets the site import a file in docs/ as the page it renders to. */
export function markdownPages(): Plugin {
  return {
    name: 'spools-markdown-pages',
    enforce: 'pre',
    async load(id) {
      const path = id.split('?')[0] ?? ''

      if (!path.startsWith(docsDirectory) || !path.endsWith('.md')) {
        return undefined
      }

      const page = await readPage(basename(path, '.md'))
      return { code: `export default ${JSON.stringify(page)}`, map: null }
    },
  }
}
