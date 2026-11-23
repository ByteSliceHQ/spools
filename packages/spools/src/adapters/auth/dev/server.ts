import { Effect, Layer } from 'effect'

import { Auth, type AuthAdapter, type AuthUser } from '../../../server/runtime/auth'
import { AuthError } from '../../../server/runtime/errors'
import { spool } from '../../../server/spool'

/**
 * Sign-in for development, tests and demos: no accounts, no passwords, no
 * outside service. Every request is signed in as one person, whose address is
 * `DEV_AUTH_EMAIL`, or else the first the config's access list lets in. The
 * access list still decides whether they may use the CRM, so it can be tried
 * out too.
 *
 *   DEV_AUTH_EMAIL        who everyone is
 *   DEV_AUTH_SIGNED_OUT   "1" to see the app as a signed-out visitor
 *
 * It refuses to run with NODE_ENV=production: anyone who could reach the app
 * would be let in.
 */

/** The teammates the directory lists besides whoever is signed in. */
export type DevPerson = { id: string; name: string; email: string }

const ME = 'user_dev'

const toAuthUser = (p: DevPerson): AuthUser => ({
  id: p.id,
  name: p.name,
  email: p.email,
  // Signed in with Google, without the mail scopes: the mailbox panel shows what is missing
  // and the sync leaves the account alone, so nothing here ever calls Google.
  accounts: [{ provider: 'google', email: p.email, scopes: ['email', 'profile', 'openid'] }],
})

// Read by a name only known when it runs, so the bundler can't replace it with the build-time value.
const env = (name: string): string | undefined => process.env[name]

/** Someone the access list lets in. */
function allowed(): string {
  const { allowedEmails, allowedDomains } = spool().config.access
  return allowedEmails[0] ?? `dev@${allowedDomains[0] ?? 'example.com'}`
}

const me = (): AuthUser =>
  toAuthUser({ id: ME, name: 'Dev User', email: env('DEV_AUTH_EMAIL') || allowed() })

/** Everyone is signed in as one person. Development only. */
export function devAuth(options: { teammates?: DevPerson[] } = {}): AuthAdapter {
  if (env('NODE_ENV') === 'production') {
    throw new Error(
      'The development sign-in lets everyone in, so it does not run in production. ' +
        'Use a real auth adapter, or run this build without NODE_ENV=production.',
    )
  }

  console.warn(
    '[auth] The development sign-in is on: everyone who can reach this server is let in.',
  )

  const everyone = () => [me(), ...(options.teammates ?? []).map(toAuthUser)]
  return {
    id: 'dev',
    label: 'The development sign-in',
    session: async () =>
      env('DEV_AUTH_SIGNED_OUT') === '1' ? null : { userId: ME, getToken: async () => null },
    layer: Layer.succeed(
      Auth,
      Auth.of({
        getUser: (id) => {
          const found = everyone().find((u) => u.id === id)
          return found
            ? Effect.succeed(found)
            : Effect.fail(new AuthError({ message: "That person doesn't exist", kind: 'answer' }))
        },
        listUsers: Effect.sync(everyone),
        accountToken: () => Effect.succeed(null),
      }),
    ),
  }
}
