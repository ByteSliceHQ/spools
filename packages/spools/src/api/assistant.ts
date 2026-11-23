import { Effect } from 'effect'

import { Agents } from '../server/runtime/agents'
import { apiRoute, type RouteInput } from '../server/runtime/boundary'
import { AgentsError, messageOf } from '../server/runtime/errors'

// Proxies the browser's useChat POST to the assistant. The engine's credential never leaves the server; the signed-in user is stamped as the author.
// The reply streams back as it comes: the program ends once the stream is handed over.
export const assistantHandlers = {
  POST: apiRoute('assistant.send', ({ request, user }: RouteInput<unknown>) =>
    Effect.gen(function* () {
      const chat = yield* Agents.use((a) => a.chat)

      if (!chat) {
        return Response.json({ error: 'Assistant not configured' }, { status: 503 })
      }

      return yield* Effect.tryPromise({
        try: () =>
          chat.forwardSend(request, { author: { memberId: user.id, displayName: user.name } }),
        catch: (cause) => new AgentsError({ message: messageOf(cause) }),
      })
    }),
  ),
}
