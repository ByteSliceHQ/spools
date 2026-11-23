import { Effect } from 'effect'

import { toolRoute } from '../server/runtime/boundary'
import { runTool } from '../server/tools'

/** The tool API Swirls calls back into: agent tools and workflow write-backs. See src/server/tools.ts. */
export const toolsHandlers = {
  POST: toolRoute(
    'swirls.tool',
    ({ request, params }: { request: Request; params: { tool: string } }) =>
      Effect.gen(function* () {
        const body = yield* Effect.promise(() => request.json().catch(() => null))
        return Response.json(yield* runTool(params.tool, body))
      }),
  ),
}
