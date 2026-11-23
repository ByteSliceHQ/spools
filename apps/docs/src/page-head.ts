import pages from './docs-manifest.json'
import { siteUrl } from './site'

export function pageHead(path: string) {
  const page = pages.find((item) => item.path === path)
  const title = `${page?.title ?? 'Documentation'} · Spools`
  const description = page?.description ?? 'Build with Spools.'

  return {
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: `${siteUrl}${path}` },
      { name: 'twitter:card', content: 'summary' },
    ],
    links: [{ rel: 'canonical', href: `${siteUrl}${path}` }],
  }
}
