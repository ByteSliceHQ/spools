import { createFileRoute, notFound } from '@tanstack/react-router'

import { DocsPage } from '../components/docs-page'
import { loadPage } from '../docs'
import { pageHead } from '../page-head'

export const Route = createFileRoute('/docs/')({
  head: () => pageHead('/docs'),
  loader: async () => {
    const page = await loadPage('README')

    if (!page) {
      throw notFound()
    }

    return page
  },
  component: Introduction,
})

function Introduction() {
  return <DocsPage page={Route.useLoaderData()} />
}
