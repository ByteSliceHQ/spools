export type Section = {
  id: string
  title: string
  level: number
}

/** One page of documentation, rendered from a file in the repository's docs/ folder. */
export type Page = {
  title: string
  description: string
  sections: Section[]
  html: string
}

const files = import.meta.glob<{ default: Page }>('../../../docs/*.md')

/** The page at /docs/<slug>, or nothing when there is none. The introduction is docs/README.md. */
export async function loadPage(slug: string): Promise<Page | undefined> {
  const load = files[`../../../docs/${slug}.md`]
  return load ? (await load()).default : undefined
}
