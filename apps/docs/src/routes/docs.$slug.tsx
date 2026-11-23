import { createFileRoute, notFound } from '@tanstack/react-router'

import { DocsPage } from '../components/docs-page'
import { loadPage } from '../docs'
import { pageHead } from '../page-head'

export const Route = createFileRoute('/docs/$slug')({
  head: ({ params }) => pageHead(`/docs/${params.slug}`),
  loader: async ({ params }) => {
    const page = params.slug === 'README' ? undefined : await loadPage(params.slug)

    if (!page) {
      throw notFound()
    }

    return page
  },
  component: Guide,
})

function Guide() {
  return <DocsPage page={Route.useLoaderData()} />
}
