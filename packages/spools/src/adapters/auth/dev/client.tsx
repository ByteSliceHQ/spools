import type { AuthClient } from '../../../crm/ui/auth'

/** The browser half of the development sign-in (server.ts is the other). */
export const devAuthClient: AuthClient = {
  id: 'dev',
  Provider: ({ children }) => <>{children}</>,
  SignIn: () => (
    <div className="max-w-sm rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-700">
      <h1 className="text-base font-semibold text-zinc-900">Development sign-in</h1>
      <p className="mt-2">
        This copy signs everyone in as one person, so there is nothing to do here.{' '}
        <a href="/" className="underline">
          Go to the CRM
        </a>
        , or unset <code>DEV_AUTH_SIGNED_OUT</code> if it sends you back.
      </p>
    </div>
  ),
  AccountButton: () => (
    <span
      className="inline-block size-6 rounded-full bg-zinc-300"
      title="Signed in with the development sign-in"
    />
  ),
  SignOut: ({ children }) => children,
  useOpenAccount: () => null,
}
