import { exchangeFederatedToken } from '@swirls/sdk/auth'
import { createSwirlsChat } from '@swirls/sdk/chat'
import { Swirls } from '@swirls/sdk/client'
import { Effect, Layer, Predicate } from 'effect'

import {
  Agents,
  type AgentsAdapter,
  type AssistantChat,
  type Run,
} from '../../../server/runtime/agents'
import type { Session } from '../../../server/runtime/auth'
import * as config from '../../../server/runtime/config'
import { AgentsError, messageOf, type Timeout } from '../../../server/runtime/errors'
import { policies, withPolicy } from '../../../server/runtime/policies'
import { currentSession } from '../../../server/runtime/session'
import { spool } from '../../../server/spool'

/**
 * Swirls (https://swirls.ai): workflows and the assistant, as deployed from the
 * app's `swirls/` folder. The only code that uses the Swirls SDK.
 *
 *   SWIRLS_PROJECT_ID    the project the .swirls files are deployed to
 *   SWIRLS_API_KEY       optional: a project API key
 *   SWIRLS_JWT_TEMPLATE  optional: the auth provider's token template for federation (default "swirls")
 *   SWIRLS_API_URL       optional override (self-hosted)
 *
 * Without an API key the app uses OIDC federation: it exchanges the signed-in
 * person's token from the auth provider (minted from a template whose `aud` is
 * the Swirls project audience) for a short-lived Swirls token, so no long-lived
 * Swirls credential is stored. Swirls then knows which person started each run,
 * and lists each person their own chats; with a project API key chats belong to
 * the project, so everyone sees everyone's. See docs/swirls.md.
 */

export type SwirlsOptions = {
  /** The assistant's agent and web channel, as swirls/assistant.swirls names them. */
  assistant?: { agentName: string; channel: string }
}

/** What a Swirls client for one request is built from. */
type SwirlsAccess = {
  /** A static key, or a function the SDK calls for a fresh token on each request. */
  apiKey: string | (() => Promise<string>)
  projectId: string
  apiUrl?: string
}

const REFRESH_SKEW_MS = 30_000
const MAX_CACHED_USERS = 500
const WORKFLOW_CACHE_MS = 60_000

const call = <A>(name: string, work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (cause) => new AgentsError({ message: messageOf(cause) }),
  }).pipe(Effect.withSpan(name))

const timedOut = (timeout: Timeout) => Effect.fail(new AgentsError({ message: timeout.message }))

const layer = (assistant: NonNullable<SwirlsOptions['assistant']>) =>
  Layer.sync(Agents, () => {
    // One Swirls token per user, never shared between users. Tokens last about 15 minutes.
    const tokens = new Map<string, { accessToken: string; expiresAt: number }>()
    // Config refers to workflows by name; executeWorkflow needs the workflow id.
    let workflowIds: { at: number; ids: Map<string, string> } | null = null

    const federatedToken = (session: Session, template: string) => async () => {
      const hit = tokens.get(session.userId)

      if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) {
        return hit.accessToken
      }

      const subjectToken = await session.getToken({ template })

      if (!subjectToken) {
        throw new AgentsError({
          message: `${spool().auth.label} returned no token for the template "${template}". Create it with aud set to the Swirls project audience, or set SWIRLS_API_KEY.`,
        })
      }

      const token = await exchangeFederatedToken({ subjectToken })

      if (tokens.size >= MAX_CACHED_USERS) {
        tokens.clear()
      }

      tokens.set(session.userId, token)
      return token.accessToken
    }

    const configured = Effect.map(config.variable('SWIRLS_PROJECT_ID'), (id) => !!id)

    /** What a client for this request is built from; null when Swirls is not set up or nobody is signed in. */
    const access = Effect.gen(function* () {
      const projectId = yield* config.variable('SWIRLS_PROJECT_ID')

      if (!projectId) {
        return null
      }

      const apiUrl = yield* config.variable('SWIRLS_API_URL')
      const apiKey = yield* config.variable('SWIRLS_API_KEY')
      let found: SwirlsAccess

      if (apiKey) {
        found = { projectId, apiKey }
      } else {
        const who = yield* currentSession

        if (!who) {
          return null
        }

        const template = (yield* config.variable('SWIRLS_JWT_TEMPLATE')) ?? 'swirls'
        found = { projectId, apiKey: federatedToken(who, template) }
      }

      // Only a set URL is passed on, so an unset one leaves the SDK's default in place.
      if (apiUrl) {
        found.apiUrl = apiUrl
      }

      return found
    })

    const resolveWorkflowId = Effect.fn('Swirls.resolveWorkflowId')(function* (
      swirls: Swirls,
      projectId: string,
      name: string,
    ) {
      if (
        !workflowIds ||
        Date.now() - workflowIds.at > WORKFLOW_CACHE_MS ||
        !workflowIds.ids.has(name)
      ) {
        const ids = new Map<string, string>()
        let after: string | undefined

        do {
          const cursor = after

          const page = yield* call('Swirls.listWorkflows', () =>
            swirls.client.workflows.listWorkflows({
              projectId,
              pagination: { first: 100, after: cursor },
            }),
          ).pipe(
            withPolicy({ ...policies.agentsRead, service: 'Swirls' }),
            Effect.catchTag('Timeout', timedOut),
          )

          for (const r of page.results) {
            if (r.isActiveDeployment) {
              ids.set(r.workflow.name, r.workflow.id)
            }
          }

          after = page.pagination.hasNextPage ? (page.pagination.endCursor ?? undefined) : undefined
        } while (after)

        workflowIds = { at: Date.now(), ids }
      }

      const id = workflowIds.ids.get(name)

      if (!id) {
        return yield* new AgentsError({
          message: `Swirls workflow "${name}" is not deployed in project ${projectId}`,
        })
      }

      return id
    })

    const executeWorkflow = Effect.fn('Swirls.executeWorkflow')(function* (
      name: string,
      // The port's own contract for a workflow's input, passed to Swirls as it is.
      input: Parameters<typeof Agents.Service.executeWorkflow>[1],
    ) {
      const found = yield* access

      if (!found) {
        const reason = (yield* configured)
          ? 'nobody is signed in and SWIRLS_API_KEY is not set'
          : 'Swirls is not configured'

        yield* Effect.logWarning(`[swirls] skipped workflow "${name}": ${reason}`)
        return { skipped: true, reason } satisfies Run
      }

      const swirls = new Swirls({ apiKey: found.apiKey, apiUrl: found.apiUrl })
      const workflowId = yield* resolveWorkflowId(swirls, found.projectId, name)

      const { executionId } = yield* call('Swirls.executeWorkflow', () =>
        swirls.client.workflows.executeWorkflow({ workflowId, input }),
      ).pipe(
        withPolicy({ ...policies.agentsRun, service: 'Swirls' }),
        Effect.catchTag('Timeout', timedOut),
      )

      return { skipped: false, executionId } satisfies Run
    })

    const chat = Effect.map(access, (found): AssistantChat | null => {
      if (!found) {
        return null
      }

      const own = createSwirlsChat({ ...found, ...assistant })
      return {
        listSessions: (...args) => own.listSessions(...args),
        createSession: (...args) => own.createSession(...args),
        getMessages: (...args) => own.getMessages(...args),
        forwardSend: (...args) => own.forwardSend(...args),
        forwardResumeStream: (...args) => own.forwardResumeStream(...args),
        // Swirls doesn't document that its web channel honours `trigger: "regenerate-message"`, and a
        // channel that ignores it would store the question twice.
        regenerate: false,
        // With a project API key the chats are the project's: everyone's. With federation they are each person's own.
        shared: Predicate.isString(found.apiKey),
        async deleteSession(sessionId) {
          const swirls = new Swirls({ apiKey: found.apiKey, apiUrl: found.apiUrl })
          const { deleted } = await swirls.client.agents.deleteSession({ sessionId })
          return deleted
        },
      }
    })

    return Agents.of({ configured, executeWorkflow, chat })
  })

export const swirls = ({
  assistant = { agentName: 'crm_assistant', channel: 'crm_web' },
}: SwirlsOptions = {}): AgentsAdapter => ({
  id: 'swirls',
  label: 'Swirls',
  layer: layer(assistant),
  features: [
    // SWIRLS_API_KEY is optional: without it the app federates the signed-in person's token.
    { name: 'Swirls workflows + assistant', vars: ['SWIRLS_PROJECT_ID'] },
  ],
})
