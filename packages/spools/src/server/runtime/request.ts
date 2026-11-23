import { Context } from 'effect'

import type { Session } from './auth'

/**
 * What the boundary knows about the request a program runs for. Read before
 * the program starts (the auth provider's session and TanStack Start's request
 * live in the request's async context, which Effect doesn't promise to carry),
 * so nothing inside an Effect asks for the session or calls `getRequest()` itself.
 */
export class CurrentRequest extends Context.Service<
  CurrentRequest,
  {
    readonly headers: Headers
    readonly signal: AbortSignal | undefined
    /**
     * The signed-in session, for services that act as the person (Swirls
     * federation turns it into a Swirls token). Null for the scheduler, a
     * webhook, or a signed-out page.
     */
    readonly session: Session | null
  }
>()('crm/CurrentRequest') {}
