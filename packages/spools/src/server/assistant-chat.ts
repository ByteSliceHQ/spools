import { Effect } from 'effect'

import { Agents } from './runtime/agents'
import { NotConfigured } from './runtime/errors'
import { scopesOn } from './scopes'

/**
 * The assistant's chat for the request being served, or null when there is
 * none. Every use of the chat goes through here.
 *
 * In a Spool with record scopes a chat is only used when its history is the
 * person's own. An engine set up with one key for the whole project keeps one
 * list of chats for everybody, so one group's conversations, with the records
 * quoted in them, would be read by another: that is refused, and staff are
 * told what to set up instead.
 */
export const SHARED_CHATS =
  "The assistant is off: this CRM keeps each group's records apart, and the assistant is set up with one key for everyone (SWIRLS_API_KEY), so everybody would see everybody's chats. Remove the key and sign people in to the agent engine as themselves (federation); see docs/swirls.md."

export const assistantChat = Effect.gen(function* () {
  const chat = yield* Agents.use((a) => a.chat)

  if (chat?.shared && scopesOn()) {
    return yield* new NotConfigured({ feature: 'assistant', message: SHARED_CHATS })
  }

  return chat
})
