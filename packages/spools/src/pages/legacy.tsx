import { redirect } from '@tanstack/react-router'

/**
 * The CRM used to live under /crm. Old bookmarks and links in sent emails still
 * point there, so send them to the same page at the root.
 */
export const legacyRedirect = {
  beforeLoad: ({
    params,
    location,
  }: {
    params: { _splat?: string }
    location: { searchStr: string }
  }) => {
    // TanStack names the rest of the address `_splat`.
    const { _splat: rest = '' } = params
    // Drop leading slashes and backslashes so "/crm//host" can't become a redirect to another site.
    const path = rest.replace(/^[/\\]+/, '')
    throw redirect({ href: `/${path}${location.searchStr}` })
  },
}
