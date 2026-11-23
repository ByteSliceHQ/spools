import { lazyRouteComponent } from '@tanstack/react-router'
import type { UIMessage } from 'ai'
import { z } from 'zod'

import { assistantStateFn } from '../server/assistant.functions'

const search = z.object({
  session: z.string().max(200).optional(),
  /** A question to ask straight away (from the Home prompt box). */
  ask: z.string().max(2000).optional(),
})

type Deps = { session: string | undefined }

/**
 * A chat's messages arrive as JSON text (Start cannot type-check their `unknown`
 * metadata as serializable), so they are checked against the chat SDK's own
 * schema before the page uses them. The SDK is loaded with this page only.
 */
async function chatHistory(json: string): Promise<UIMessage[]> {
  if (json === '[]') {
    return []
  }

  const { validateUIMessages } = await import('ai')
  return validateUIMessages({ messages: JSON.parse(json) })
}

export const assistantPage = {
  validateSearch: search,
  loaderDeps: (from: { search: z.output<typeof search> }): Deps => ({
    session: from.search.session,
  }),
  loader: async ({ deps }: { deps: Deps }) => {
    const { messagesJson, ...state } = await assistantStateFn({
      data: { sessionId: deps.session },
    })

    return { ...state, messages: await chatHistory(messagesJson) }
  },
  component: lazyRouteComponent(() => import('../views/assistant'), 'AssistantPage'),
}
