/// <reference types="vite/client" />

import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'

import { AuthClientProvider } from '@swirls/spools/ui/auth'
import { getBrandFn } from '@swirls/spools/ui/brand'

import { authClients } from '../spool.ui'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  // The business name from crm.config.json; loaded once and reused by every page.
  loader: () => getBrandFn(),
  staleTime: Number.POSITIVE_INFINITY,
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: loaderData?.name ?? '' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const brand = Route.useLoaderData()
  return (
    <AuthClientProvider clients={authClients} id={brand?.auth}>
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <Outlet />
          <Scripts />
        </body>
      </html>
    </AuthClientProvider>
  )
}
