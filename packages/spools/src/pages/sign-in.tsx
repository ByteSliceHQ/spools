import type { ReactNode } from 'react'

import { useAuth } from '../crm/ui/auth'

export const signInPage = { component: SignInPage }

function SignInPage(): ReactNode {
  const { SignIn } = useAuth()
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <SignIn path="/sign-in" redirectTo="/" />
    </div>
  )
}
