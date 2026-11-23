import { Effect } from 'effect'

import { createAuthRequest, isProvider, OAUTH_COOKIE } from '../server/integrations'
import { apiRoute, type RouteInput } from '../server/runtime/boundary'
import * as config from '../server/runtime/config'

const back = (error: string) =>
  new Response(null, {
    status: 302,
    headers: { location: `/integrations?error=${encodeURIComponent(error)}` },
  })

/**
 * Start connecting the signed-in teammate's Google or Microsoft account: sets a
 * short-lived cookie that ties the flow to this browser, then redirects to the
 * provider's consent screen.
 */
export const integrationConnectHandlers = {
  GET: apiRoute(
    'integrations.connect',
    ({ request, params, user }: RouteInput<{ provider: string }>) => {
      // Only our own pages may start a connection for someone.
      const site = request.headers.get('sec-fetch-site')

      if (site && site !== 'same-origin' && site !== 'none') {
        return Effect.succeed(new Response('Forbidden', { status: 403 }))
      }

      if (!isProvider(params.provider)) {
        return Effect.succeed(new Response('Unknown provider', { status: 404 }))
      }

      return Effect.gen(function* () {
        const { url, cookie } = yield* createAuthRequest(params.provider, user.id)

        const secure = ((yield* config.variable('APP_URL')) ?? '').startsWith('https://')
          ? '; Secure'
          : ''

        return new Response(null, {
          status: 302,
          headers: {
            location: url,
            'set-cookie': `${OAUTH_COOKIE}=${cookie}; Path=/api/integrations; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
            'cache-control': 'no-store',
          },
        })
      }).pipe(Effect.catchTag('IntegrationError', (error) => Effect.succeed(back(error.message))))
    },
    { signedOut: () => new Response(null, { status: 302, headers: { location: '/sign-in' } }) },
  ),
}
