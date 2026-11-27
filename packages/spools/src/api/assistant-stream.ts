import { Effect } from 'effect'

import { assistantChat } from '../server/assistant-chat'
import { apiRoute, type RouteInput } from '../server/runtime/boundary'

// useChat resume: GET {api}/{chatId}/stream
export const assistantStreamHandlers = {
  GET: apiRoute('assistant.resume', ({ params }: RouteInput<{ sessionId: string }>) =>
    Effect.gen(function* () {
      const chat = yield* assistantChat

      if (!chat) {
        return new Response(null, { status: 204 })
      }

      // Nothing to rejoin is the normal case when opening an old chat. Whatever the
      // channel answers then, tell useChat "no stream" so it keeps the loaded history
      // instead of showing an error.
      const upstream = yield* Effect.promise(() =>
        chat.forwardResumeStream(params.sessionId).catch(() => null),
      )

      return upstream?.ok ? upstream : new Response(null, { status: 204 })
    }),
  ),
}
