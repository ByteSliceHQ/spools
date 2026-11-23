import type { Duration } from 'effect'

import * as boundary from './runtime/boundary'
import type { RouteInput } from './runtime/boundary'
import { fromHook, type Unauthorized } from './runtime/errors'
import type { CrmUser } from './users'

/**
 * For an app's own server functions and endpoints. Each of these checks who is
 * asking before your code runs, gives it the person, stops when the browser goes
 * away, and shows the page the message of an error you throw. They are the
 * framework's own (runtime/boundary.ts), taking plain functions.
 *
 *   import { createServerFn } from '@tanstack/react-start'
 *   import { crmHandler } from '@swirls/spools/handlers'
 *
 *   export const stockFn = createServerFn({ method: 'GET' })
 *     .validator(z.object({ sku: z.string() }))
 *     .handler(crmHandler('stock', async ({ data, user }) => lookUp(data.sku)))
 *
 * The lint rules a new Spool comes with refuse a handler that goes without one.
 */

export type { CrmUser, RouteInput }

/** A server function for signed-in teammates. */
export const crmHandler = <I, A>(
  name: string,
  answer: (input: { data: I; user: CrmUser }) => A | PromiseLike<A>,
  options?: { headers?: Record<string, string> },
) =>
  boundary.crmHandler(
    name,
    (input: { data: I; user: CrmUser }) => fromHook(name, () => answer(input)),
    options,
  )

/** A server function that answers anyone, signed in or not. Nothing staff-only belongs here. */
export const publicHandler = <I, A>(
  name: string,
  answer: (input: { data: I }) => A | PromiseLike<A>,
) => boundary.publicHandler(name, (input: { data: I }) => fromHook(name, () => answer(input)))

/** An endpoint for signed-in teammates. */
export const apiRoute = <P>(
  name: string,
  answer: (input: RouteInput<P>) => Response | PromiseLike<Response>,
  options?: { signedOut?: (error: Unauthorized) => Response },
) => boundary.apiRoute(name, (input: RouteInput<P>) => fromHook(name, () => answer(input)), options)

/**
 * An endpoint that proves who is calling some other way than the session: check
 * the signature of a webhook, or the token in a link, before anything else.
 */
export const publicRoute = (
  name: string,
  answer: (request: Request) => Response | PromiseLike<Response>,
) => boundary.publicRoute(name, (request) => fromHook(name, () => answer(request)))

/** A scheduled job's endpoint: refuses anyone without `CRON_SECRET`, and answers 504 after `limit`. */
export const cronRoute = (
  name: string,
  answer: (request: Request) => Response | PromiseLike<Response>,
  options?: { limit?: Duration.Input },
) => boundary.cronRoute(name, (request) => fromHook(name, () => answer(request)), options)
