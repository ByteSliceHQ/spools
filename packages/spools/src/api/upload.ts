import { Effect } from 'effect'

import { relayContent } from '../server/files'
import { apiRoute, type RouteInput } from '../server/runtime/boundary'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Pass an upload's bytes on to the file store. Used only when the store asks for
 * the file to be relayed instead of sent to it directly; a host that limits
 * request size limits these uploads too.
 */
export const uploadHandlers = {
  PUT: apiRoute(
    'files.relay',
    ({ request, params, user }: RouteInput<{ id: string }>) => {
      // Only our own pages may send a file for someone.
      const site = request.headers.get('sec-fetch-site')

      if (site && site !== 'same-origin') {
        return Effect.succeed(new Response('Forbidden', { status: 403 }))
      }

      if (!UUID.test(params.id)) {
        return Effect.succeed(new Response('Not found', { status: 404 }))
      }

      const length = Number(request.headers.get('content-length'))

      if (!request.body || !Number.isSafeInteger(length) || length <= 0) {
        return Effect.succeed(new Response('Send the file with its length.', { status: 411 }))
      }

      return relayContent(params.id, request.body, length, user).pipe(
        Effect.as(Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })),
        Effect.catchTag('FilesError', (error) =>
          Effect.succeed(new Response(error.message, { status: 400 })),
        ),
        Effect.catch((error) =>
          Effect.logError('[files] relay failed', error).pipe(
            Effect.as(new Response('Something went wrong while adding the file.', { status: 500 })),
          ),
        ),
      )
    },
    { signedOut: () => new Response('Sign in again.', { status: 401 }) },
  ),
}
