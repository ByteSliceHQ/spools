import { Effect } from 'effect'

import { fileResponse, linkResponse } from '../server/downloads'
import { openFile } from '../server/files'
import { apiRoute, type RouteInput } from '../server/runtime/boundary'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Open a file: checks the CRM session, then redirects to a link the file store
 * signs for this one file, good for a few minutes, or (a store that signs no
 * links) answers with the file's bytes. The store's key is never sent to the
 * browser. `id` is the store's id for the file.
 */
export const fileHandlers = {
  GET: apiRoute(
    'files.download',
    ({ params, request }: RouteInput<{ id: string }>) => {
      if (!UUID.test(params.id)) {
        return Effect.succeed(new Response('Not found', { status: 404 }))
      }

      // In a Spool with record scopes the link says which folder the file is in (`?folder=`),
      // and the file is only opened from a folder within reach. Top level: `?folder=`, empty.
      const folder = new URL(request.url).searchParams.get('folder')
      const inFolder = folder === null ? undefined : folder || null

      return openFile(params.id, inFolder).pipe(
        Effect.map((file) => (file.kind === 'link' ? linkResponse(file.url) : fileResponse(file))),
        Effect.catchTag('FilesError', (error) =>
          Effect.succeed(
            new Response(error.message, {
              status: error.status === 404 || !error.status ? 404 : 502,
            }),
          ),
        ),
      )
    },
    { signedOut: () => new Response(null, { status: 302, headers: { location: '/sign-in' } }) },
  ),
}
