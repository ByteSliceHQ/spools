import { getRouteApi, Outlet, redirect } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'

import type { PublicCrmConfig } from '../crm/config'
import { useAuth } from '../crm/ui/auth'
import { CrmUsersContext } from '../crm/ui/fields'
import { crmSession, rememberCrmSession } from '../crm/ui/session'
import { CrmShell } from '../crm/ui/shell'

const route = getRouteApi('/_crm')

export const crmLayout = {
  // Runs before every navigation and every link preload, so it must not cost a
  // request each time: the browser keeps the session it has (crm/ui/session.ts).
  beforeLoad: async () => {
    const session = await crmSession()

    if (!session.signedIn) {
      throw redirect({ to: '/sign-in/$', params: { _splat: '' } })
    }

    return {
      user: session.user,
      config: session.config,
      users: session.users,
      favorites: session.favorites,
      dueTasks: session.dueTasks,
      guides: session.guides,
    }
  },
  head: ({ match }: { match: { context: { config: PublicCrmConfig | null } } }) => ({
    meta: [{ title: match.context.config ? `${match.context.config.app.name} CRM` : 'CRM' }],
  }),
  component: CrmLayout,
}

function CrmLayout(): ReactNode {
  const { user, config, users, favorites, dueTasks, guides } = route.useRouteContext()
  const { SignOut } = useAuth()

  // The server sent the session with the page: keep it, so the first click doesn't ask again.
  useEffect(() => {
    if (user && config) {
      rememberCrmSession({ signedIn: true, user, config, users, favorites, dueTasks, guides })
    }
  }, [user, config, users, favorites, dueTasks, guides])

  if (!user || !config) {
    return (
      <div className="crm flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-base font-semibold">You don't have access to this CRM</h1>
        <p className="text-c-fg2 max-w-md">
          Your account signed in, but its verified email isn't on the allowlist in{' '}
          <code>crm.config.json</code>.
        </p>
        <SignOut>
          <button
            type="button"
            className="border-c-line2 hover:bg-c-hov h-7 rounded-lg border px-2.5 font-medium"
          >
            Sign out
          </button>
        </SignOut>
      </div>
    )
  }

  return (
    <CrmShell config={config} user={user} favorites={favorites} dueTasks={dueTasks} guides={guides}>
      <CrmUsersContext value={users}>
        <Outlet />
      </CrmUsersContext>
    </CrmShell>
  )
}
