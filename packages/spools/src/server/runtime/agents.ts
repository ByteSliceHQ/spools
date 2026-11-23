import { Context, Effect, Layer } from 'effect'

import type { Adapter } from './adapter'
import type { AgentsError } from './errors'

/**
 * The engine that runs a Spool's agents and workflows. Config targets such as
 * `"run": "swirls:new_contact"` start a workflow here, and the Ask page talks to
 * the assistant through `chat`. Swirls is the one built in
 * (src/adapters/agents/swirls). Without an engine the CRM works as it is:
 * workflows are skipped and say so on the record's timeline, and the Ask page
 * says the assistant isn't connected.
 *
 * An engine never touches the database. It calls back into the tool API
 * (src/server/tools.ts).
 */

/** A workflow that was started, or why it wasn't. */
export type Run = { skipped: true; reason: string } | { skipped: false; executionId: string }

/** The assistant's conversations, as the Ask page needs them. The engine keeps them: the CRM has no table for chats. */
export type AssistantChat = {
  listSessions(options?: {
    limit?: number
  }): Promise<{ sessionId: string; title: string | null; updatedAt: Date }[]>
  createSession(options?: { title?: string | null }): Promise<{ sessionId: string }>
  /** A conversation's messages, in the AI SDK's `UIMessage` shape. */
  getMessages(sessionId: string): Promise<{ messages: readonly unknown[] }>
  /** Passes a message the browser posted on to the assistant, and its reply back as it comes. */
  forwardSend(
    request: Request,
    options: { author: { memberId: string; displayName: string } },
  ): Promise<Response>
  /** Rejoins a reply still being written. */
  forwardResumeStream(sessionId: string): Promise<Response>
  /** Delete a conversation and its messages. False when there was nothing to delete. */
  deleteSession(sessionId: string): Promise<boolean>
  /** Whether a reply can be asked for again (the AI SDK's `regenerate()`). The page offers it only where this is true. */
  readonly regenerate: boolean
}

/** How many past chats the Ask page lists. */
export const CHATS_LISTED = 30

export class Agents extends Context.Service<
  Agents,
  {
    /** Whether an engine is set up at all. */
    readonly configured: Effect.Effect<boolean>
    /** Start a deployed workflow by name. Skipped (not failed) when the engine can't be used for this request. */
    readonly executeWorkflow: (
      name: string,
      input: Record<string, unknown>,
    ) => Effect.Effect<Run, AgentsError>
    /** The assistant's chat for this request, or null when there is none (no engine, nobody signed in). */
    readonly chat: Effect.Effect<AssistantChat | null>
  }
>()('spools/Agents') {
  /** A Spool with no engine. */
  static readonly none = Layer.succeed(
    Agents,
    Agents.of({
      configured: Effect.succeed(false),
      executeWorkflow: () => Effect.succeed({ skipped: true, reason: 'no agent engine is set up' }),
      chat: Effect.succeed(null),
    }),
  )
}

export type AgentsAdapter = Adapter<Agents> & {
  /** What the Ask page shows when the assistant isn't connected: how to connect it. */
  readonly setup?: string
}
