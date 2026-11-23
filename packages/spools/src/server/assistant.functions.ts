import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import { TITLE_MAX } from '../crm/assistant'
import { Agents, type AssistantChat, CHATS_LISTED } from './runtime/agents'
import { crmHandler } from './runtime/boundary'
import { AgentsError, Invalid, messageOf, NotConfigured } from './runtime/errors'
import { policies, withPolicy } from './runtime/policies'

/**
 * Sessions for the in-CRM assistant. The agent engine keeps them
 * (runtime/agents.ts), so nothing here touches the database.
 */

const notConfigured = new NotConfigured({
  feature: 'assistant',
  message:
    'The assistant is not configured (SWIRLS_PROJECT_ID, and SWIRLS_API_KEY or federation with your sign-in provider)',
})

/** The assistant's chat for this person, or `NotConfigured`. */
const chatOrRefuse = Agents.use((a) => a.chat).pipe(
  Effect.filterOrFail(
    (chat) => chat !== null,
    () => notConfigured,
  ),
)

/** A chat as the assistant's list shows it. */
type SessionSummary = { sessionId: string; title: string | null; updatedAt: string }

/** One call to the chat, with the engine's time limit. */
const ask = <A>(name: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new AgentsError({ message: messageOf(cause) }),
  }).pipe(
    withPolicy(policies.agentsRun, () => false),
    Effect.catchTag('Timeout', (timeout) =>
      Effect.fail(new AgentsError({ message: timeout.message })),
    ),
    Effect.withSpan(`assistant.${name}`),
  )

export const assistantStateFn = createServerFn({ method: 'GET' })
  .validator(z.object({ sessionId: z.string().max(200).optional() }))
  .handler(
    crmHandler('assistant.state', ({ data }) =>
      Effect.gen(function* () {
        const chat: AssistantChat | null = yield* Agents.use((a) => a.chat)

        if (!chat) {
          const none: SessionSummary[] = []
          return {
            configured: false as const,
            canRegenerate: false,
            sessions: none,
            messagesJson: '[]',
          }
        }

        const { sessionId } = data

        const [sessions, history] = yield* Effect.all(
          [
            ask('listSessions', () => chat.listSessions({ limit: CHATS_LISTED })),
            sessionId
              ? ask('getMessages', () => chat.getMessages(sessionId))
              : Effect.succeed({ messages: [] }),
          ],
          { concurrency: 2 },
        )

        return {
          configured: true as const,
          canRegenerate: chat.regenerate,
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            title: s.title,
            updatedAt: s.updatedAt.toISOString(),
          })),
          // UIMessage carries `unknown` metadata, which Start cannot type-check as serializable.
          messagesJson: JSON.stringify(history.messages),
        }
      }),
    ),
  )

export const createAssistantSessionFn = createServerFn({ method: 'POST' })
  // A chat is titled from its first message (`titleFrom`); a longer title is one that was not made by the page.
  .validator(
    z.object({
      title: z
        .string()
        .trim()
        .min(1)
        .max(TITLE_MAX + 1)
        .optional(),
    }),
  )
  .handler(
    crmHandler('assistant.createSession', ({ data }) =>
      Effect.flatMap(chatOrRefuse, (chat) =>
        ask('createSession', () => chat.createSession({ title: data.title ?? null })),
      ),
    ),
  )

export const deleteAssistantSessionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ sessionId: z.string().min(1).max(200) }))
  .handler(
    crmHandler('assistant.deleteSession', ({ data }) =>
      Effect.gen(function* () {
        const chat = yield* chatOrRefuse
        // Only a chat this person is shown may be deleted by them: the id alone is not enough.
        const listed = yield* ask('listSessions', () => chat.listSessions({ limit: CHATS_LISTED }))

        if (!listed.some((s) => s.sessionId === data.sessionId)) {
          return yield* new Invalid({ message: 'That chat is not in your list' })
        }

        const deleted = yield* ask('deleteSession', () => chat.deleteSession(data.sessionId))
        return { deleted }
      }),
    ),
  )
