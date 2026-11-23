import {
  ClerkProvider,
  SignIn,
  SignOutButton,
  UserButton,
  useClerk,
} from '@clerk/tanstack-react-start'

import type { AuthClient } from '../../../crm/ui/auth'

/** The browser half of the Clerk adapter (server.ts is the other). */
export const clerkClient: AuthClient = {
  id: 'clerk',
  Provider: ({ children }) => <ClerkProvider>{children}</ClerkProvider>,
  SignIn: ({ path, redirectTo }) => (
    <SignIn routing="path" path={path} forceRedirectUrl={redirectTo} />
  ),
  AccountButton: ({ scopes }) => (
    <UserButton userProfileProps={{ additionalOAuthScopes: scopes }} />
  ),
  SignOut: ({ children }) => <SignOutButton>{children}</SignOutButton>,
  useOpenAccount: () => {
    const clerk = useClerk()
    return ({ scopes } = {}) => clerk.openUserProfile({ additionalOAuthScopes: scopes })
  },
}
