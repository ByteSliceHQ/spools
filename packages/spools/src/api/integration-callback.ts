import { Effect } from 'effect'

import { completeAuth, isProvider, OAUTH_COOKIE, providers } from '../server/integrations'
import { runtime } from '../server/runtime/app'
import { apiRoute, type RouteInput } from '../server/runtime/boundary'
import { syncMine } from '../server/sync'

const cookieValue = (header: string | null, name: string): string | undefined =>
  header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)

/** Back to the Integrations page, with what happened in the address. */
const done = (search: Record<string, string>) =>
  new Response(null, {
    status: 302,
    headers: {
      location: `/integrations?${new URLSearchParams(search)}`,
      // The cookie is single-use.
      'set-cookie': `${OAUTH_COOKIE}=; Path=/api/integrations; Max-Age=0; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  })

/** Where the provider sends the browser back to: finish the connection and return to the Integrations page. */
export const integrationCallbackHandlers = {
  GET: apiRoute(
    'integrations.callback',
    ({ request, params, user }: RouteInput<{ provider: string }>) => {
      if (!isProvider(params.provider)) {
        return Effect.succeed(new Response('Unknown provider', { status: 404 }))
      }

      const id = params.provider
      const label = providers()[id]?.label ?? id
      const query = new URL(request.url).searchParams
      const code = query.get('code')

      if (!code) {
        // The person declined, or the provider reported a problem.
        const declined = query.get('error') === 'access_denied'
        return Effect.succeed(
          done({
            error: declined
              ? `You didn't finish connecting ${label}, so nothing was connected.`
              : `${label} could not connect the account. Try again.`,
          }),
        )
      }

      return completeAuth(
        id,
        {
          code,
          state: query.get('state'),
          cookie: cookieValue(request.headers.get('cookie'), OAUTH_COOKIE),
          query,
        },
        // Whose the connection is comes from the signed state: nothing in this address decides it.
        user,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // A new mailbox: start reading it straight away, on the server's runtime, without making the
            // browser wait. It outlives this request on purpose.
            if (providers()[id]?.mailbox) {
              runtime().runFork(Effect.ignore(syncMine(user)))
            }
          }),
        ),
        Effect.map((connection) => done({ connected: connection.id })),
        Effect.catchTags({
          IntegrationError: (error) => Effect.succeed(done({ error: error.message })),
          VaultError: (error) => Effect.succeed(done({ error: error.message })),
        }),
        Effect.catch((error) =>
          Effect.logError('[integrations] callback failed', error).pipe(
            Effect.as(
              done({ error: 'Something went wrong while connecting the account. Try again.' }),
            ),
          ),
        ),
      )
    },
    { signedOut: () => new Response(null, { status: 302, headers: { location: '/sign-in' } }) },
  ),
}
