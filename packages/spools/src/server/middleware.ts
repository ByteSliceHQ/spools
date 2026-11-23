import { createCsrfMiddleware, createMiddleware } from '@tanstack/react-start'

import { spool } from './spool'

/** Request middleware every Spool needs, for `createStart` in the app's src/start.ts. */

/**
 * Reject cross-site requests to anything a signed-in browser can call with its
 * session cookie: server functions and the assistant chat endpoint. Other /api
 * routes authenticate with a bearer token or a signature, not the cookie.
 */
export const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) =>
    ctx.handlerType === 'serverFn' ||
    new URL(ctx.request.url).pathname.startsWith('/api/assistant'),
})

/** Runs the auth adapter's own middleware, if it has one (Clerk reads its session there). */
export const authMiddleware = createMiddleware().server((ctx) => {
  const own = spool().auth.middleware?.options.server
  return own ? own(ctx) : ctx.next()
})
