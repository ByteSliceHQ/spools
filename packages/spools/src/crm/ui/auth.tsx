import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react'

/**
 * The browser half of an auth adapter: the few things the interface asks of
 * whoever signs people in. The server half is src/server/runtime/auth.ts.
 *
 * An app passes one to `AuthClientProvider` in its root route; pages reach it
 * with `useAuth()` and never import an auth provider's SDK.
 */

/** OAuth scopes to ask for, by sign-in provider ("google", "microsoft"). */
export type Scopes = Record<string, string[]>

export type AuthClient = {
  /** The same short name as the server half's, e.g. "clerk". */
  readonly id: string
  /** Wraps the whole document, for a provider that needs a context. */
  readonly Provider: ComponentType<{ children: ReactNode }>
  /** The sign-in form. `path` is the page it is on (`/sign-in`), which it may add segments to. */
  readonly SignIn: ComponentType<{ path: string; redirectTo: string }>
  /** The signed-in person's account menu. `scopes` are what the CRM would like their account to grant. */
  readonly AccountButton: ComponentType<{ scopes?: Scopes }>
  /** Signs out when its child (a button) is clicked. */
  readonly SignOut: ComponentType<{ children: ReactElement }>
  /**
   * A function that opens the person's account page, where they can grant more
   * access. Null when this provider has no such page.
   */
  readonly useOpenAccount: () => ((options?: { scopes?: Scopes }) => void) | null
}

const AuthContext = createContext<AuthClient | null>(null)

/**
 * Makes the auth provider's browser half available to every page. Goes in the
 * root route, around the document. `id` is the adapter the server chose: the
 * two halves must be the same provider's, or nobody could sign in.
 */
export function AuthClientProvider({
  clients,
  id,
  children,
}: {
  clients: readonly AuthClient[]
  id: string | undefined
  children: ReactNode
}) {
  // Without an answer from the server (its error page is showing), any of them will do.
  const client = id === undefined ? clients[0] : clients.find((c) => c.id === id)

  if (!client) {
    throw new Error(
      `The server signs people in with "${id}", but src/spool.ui.ts has no browser half for it.`,
    )
  }

  return (
    <AuthContext value={client}>
      <client.Provider>{children}</client.Provider>
    </AuthContext>
  )
}

/** The app's auth provider, in the browser. */
export function useAuth(): AuthClient {
  const client = useContext(AuthContext)

  if (!client) {
    throw new Error('No auth client. Wrap the root route in <AuthClientProvider>.')
  }

  return client
}
