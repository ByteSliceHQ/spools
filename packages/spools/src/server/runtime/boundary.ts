import { getRequest, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server'
import { Cause, Duration, Effect, Exit, type ManagedRuntime, Option } from 'effect'

import { spool } from '../spool'
import { type CrmUser, Users } from '../users'
import { type AppServices, CurrentRequest, runtime, type Services } from './app'
import type { Session } from './auth'
import { bearerMatches } from './bearer'
import * as config from './config'
import { cronSecret, reveal } from './config'
import { Invalid, type StaffError, Unauthorized } from './errors'

/**
 * Where TanStack Start hands a request to an Effect program, and gets back
 * what the browser sees. Every server function and API route goes through one
 * of these (lint refuses one that doesn't; see docs/server-code.md). An app's
 * own use the same, as promises (server/handlers.ts):
 *
 *   export const markGuideFn = createServerFn({ method: "POST" })
 *     .validator(guides.markInput)
 *     .handler(crmHandler("markGuide", ({ data, user }) => guides.markGuide(user.id, data.id, data.outcome)));
 *
 * What the boundary does, in order:
 *   1. reads what belongs to the request (the auth adapter's session, the
 *      request's headers and abort signal) before any Effect runs;
 *   2. checks the person may use the CRM, failing with `Unauthorized`;
 *   3. runs the program on the process's runtime, with a span named after it;
 *   4. interrupts the program if the browser goes away (src/server.ts answers 499);
 *   5. turns a typed error into an `Error` whose message is the error's own,
 *      which is what the page shows; logs anything unexpected in full with a
 *      reference, and rethrows it as it was.
 */

type Runtime = ManagedRuntime.ManagedRuntime<AppServices, never>

/** A program the boundary can run: only the app's services, only errors staff can read. */
export type Program<A, E extends StaffError> = Effect.Effect<A, E, Services>

/** Slower than this, a successful call is logged too. */
const SLOW_MS = 1000

const reference = () => crypto.randomUUID().slice(0, 8)

/** The request TanStack Start is serving, read outside Effect. */
function currentRequest(session: Session | null): CurrentRequest['Service'] {
  const request = getRequest()
  return { headers: request.headers, signal: request.signal, session }
}

/** The session of the request being served, from the Spool's auth adapter, read outside Effect. */
const sessionOf = (request: Request): Promise<Session | null> => spool().auth.session(request)

/** The signed-in person, if the config's access list lets them in. */
export const signedIn = Effect.fn('signedIn')(function* (userId: string | null | undefined) {
  if (!userId) {
    return yield* new Unauthorized({ reason: 'signed-out' })
  }

  const user = yield* (yield* Users).crmUser(userId)

  if (!user) {
    return yield* new Unauthorized({ reason: 'not-allowed' })
  }

  return user
})

/**
 * Runs a program for one request and settles it the way the browser expects.
 * Exported for tests, which pass a runtime built from fake layers; app code
 * uses the wrappers below.
 */
export async function serve<A, E extends StaffError>(
  rt: Runtime,
  name: string,
  request: CurrentRequest['Service'],
  program: Program<A, E>,
): Promise<A> {
  const started = performance.now()

  const exit = await rt.runPromiseExit(
    program.pipe(Effect.provideService(CurrentRequest, request), Effect.withSpan(name)),
    { signal: request.signal },
  )

  const ms = Math.round(performance.now() - started)

  if (Exit.isSuccess(exit)) {
    if (ms > SLOW_MS) {
      console.info(`[server] ${name} took ${ms} ms`)
    }

    return exit.value
  }

  return settleFailure(name, ms, exit.cause)
}

function settleFailure(name: string, ms: number, cause: Cause.Cause<StaffError>): never {
  // The browser went away and the program was interrupted. src/server.ts turns this into a 499.
  if (Cause.hasInterruptsOnly(cause)) {
    throw new DOMException('The request was cancelled', 'AbortError')
  }

  const error = Cause.findErrorOption(cause)

  if (Option.isSome(error)) {
    // Signed-out pages ask too; that isn't worth a log line.
    if (error.value._tag !== 'Unauthorized') {
      console.warn(
        `[server] ${name} failed after ${ms} ms: ${error.value._tag}: ${error.value.message}`,
      )
    }

    throw new Error(error.value.message)
  }

  // A bug, or a library throwing where it shouldn't. Log everything once, keep today's behaviour.
  const ref = reference()
  console.error(`[server] ${name} failed after ${ms} ms (reference ${ref})\n${Cause.pretty(cause)}`)
  throw Cause.squash(cause)
}

/**
 * Says 403 for a page asked for by someone who is signed in but not on the
 * access list. The page that says so is drawn all the same; without this its
 * failed loaders would make it a 500, and a refusal would read as a fault of
 * the server's. A server function called from the browser keeps its own answer.
 */
const refusedPage = (request: Request) => (error: StaffError) =>
  Effect.sync(() => {
    if (
      error._tag === 'Unauthorized' &&
      error.reason === 'not-allowed' &&
      !request.headers.has('x-tsr-serverFn')
    ) {
      setResponseStatus(403)
    }
  })

/**
 * A server function for signed-in staff. The program gets the validated
 * `data` and the signed-in `user`; there is no other way to learn who is asking.
 */
export function crmHandler<I, A, E extends StaffError>(
  name: string,
  program: (input: { data: I; user: CrmUser }) => Program<A, E>,
  options: { headers?: Record<string, string> } = {},
): (ctx: { data: I }) => Promise<A> {
  return async ({ data }) => {
    const asked = getRequest()
    const session = await sessionOf(asked)
    const request = currentRequest(session)

    // Response headers belong to the request too: set here, never from inside the program.
    for (const [header, value] of Object.entries(options.headers ?? {})) {
      setResponseHeader(header, value)
    }

    return serve(
      runtime(),
      name,
      request,
      signedIn(session?.userId).pipe(
        Effect.tapError(refusedPage(asked)),
        Effect.flatMap((user) => program({ data, user })),
      ),
    )
  }
}

/**
 * A program as someone who isn't signed in may hear of it. Staff are shown the
 * database's own words when it fails (errors.ts); a stranger is not, since they
 * name the host, the tables and their rules. The words go to the log instead.
 * Exported for tests.
 */
export const forStrangers = <A, E extends StaffError, R>(
  name: string,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Invalid, R> =>
  program.pipe(
    Effect.tapError((error) =>
      error._tag === 'DatabaseError'
        ? Effect.logError(`[server] ${name} failed: DatabaseError: ${error.message}`)
        : Effect.void,
    ),
    Effect.mapError((error) =>
      error._tag === 'DatabaseError'
        ? new Invalid({ message: 'Something went wrong on our side. Try again in a moment.' })
        : error,
    ),
  )

/**
 * A server function that also answers signed-out pages (sign-in, unsubscribe,
 * the session check). Nothing staff-only belongs here. The program may ask who
 * is signed in, if anyone, with `signedInUser`.
 */
export function publicHandler<I, A, E extends StaffError>(
  name: string,
  program: (input: { data: I }) => Program<A, E>,
): (ctx: { data: I }) => Promise<A> {
  return async ({ data }) =>
    serve(
      runtime(),
      name,
      currentRequest(await sessionOf(getRequest())),
      forStrangers(name, program({ data })),
    )
}

/** The CRM user signed in to this request, or null (signed out, or not on the access list). */
export const signedInUser = Effect.gen(function* () {
  const request = yield* CurrentRequest

  if (!request.session) {
    return null
  }

  return yield* (yield* Users).crmUser(request.session.userId)
})

/** Whether a request is from the scheduler: `CRON_SECRET` set (16+ characters) and sent as a bearer token. */
export const cronAuthorized = (headers: Headers) =>
  Effect.map(Effect.orDie(cronSecret), (secret) => {
    const expected = reveal(secret)
    return !!expected && expected.length >= 16 && bearerMatches(headers, expected)
  })

/**
 * An API route for signed-in staff (/api/files/*, ...). The program gets the
 * request, the route's params and the signed-in `user`, and answers with a
 * `Response`. Signed out (or not allowed) is answered by `signedOut`, 401 JSON
 * by default; a typed failure the program doesn't answer itself is 500 JSON
 * with its message.
 */
export type RouteInput<P> = { request: Request; params: P; user: CrmUser }

export function apiRoute<P, E extends StaffError>(
  name: string,
  program: (input: RouteInput<P>) => Program<Response, E>,
  options: { signedOut?: (error: Unauthorized) => Response } = {},
): (ctx: { request: Request; params: P }) => Promise<Response> {
  return async ({ request, params }) => {
    const session = await sessionOf(request)
    return serve(
      runtime(),
      name,
      { headers: request.headers, signal: request.signal, session },
      signedIn(session?.userId).pipe(
        Effect.flatMap((user) => program({ request, params, user })),
        Effect.catch((error: StaffError) =>
          Effect.succeed(
            error._tag === 'Unauthorized' && options.signedOut
              ? options.signedOut(error)
              : failureResponse(error),
          ),
        ),
      ),
    )
  }
}

/**
 * A route that proves who is calling some other way than the session: a
 * signed webhook (Resend), a token in a link (one-click unsubscribe). The
 * program checks the signature or token itself, first. A typed failure it
 * doesn't answer becomes 500 JSON with its message.
 */
export function publicRoute<E extends StaffError>(
  name: string,
  program: (request: Request) => Program<Response, E>,
): (ctx: { request: Request }) => Promise<Response> {
  return ({ request }) =>
    serve(
      runtime(),
      name,
      { headers: request.headers, signal: request.signal, session: null },
      forStrangers(name, program(request)).pipe(
        Effect.catch((error: StaffError) => Effect.succeed(failureResponse(error))),
      ),
    )
}

/** Whether a request is from Swirls: `SWIRLS_APP_TOKEN` set (32+ characters) and sent as a bearer token. */
export const toolAuthorized = (headers: Headers) =>
  Effect.map(config.variable('SWIRLS_APP_TOKEN'), (expected) => {
    return !!expected && expected.length >= 32 && bearerMatches(headers, expected)
  })

/**
 * The tool API Swirls calls back into (/api/swirls/tools/*): refuses anyone
 * without `Authorization: Bearer $SWIRLS_APP_TOKEN` (401), then runs the
 * program. Nobody is signed in: the tool acts as the assistant.
 */
export function toolRoute<P, E extends StaffError>(
  name: string,
  program: (input: { request: Request; params: P }) => Program<Response, E>,
): (ctx: { request: Request; params: P }) => Promise<Response> {
  return ({ request, params }) =>
    serve(
      runtime(),
      name,
      { headers: request.headers, signal: request.signal, session: null },
      Effect.gen(function* () {
        if (!(yield* toolAuthorized(request.headers))) {
          return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        return yield* program({ request, params })
      }).pipe(Effect.catch((error: StaffError) => Effect.succeed(failureResponse(error)))),
    )
}

/** Answers a route's typed failure as JSON: 401 when signed out, 500 otherwise. */
const failureResponse = (error: StaffError) =>
  Response.json(
    { ok: false, error: error.message },
    { status: error._tag === 'Unauthorized' ? 401 : 500 },
  )

/**
 * A scheduled job's route (/api/cron/*): refuses anyone without the cron
 * secret, and gives the run an overall limit (default 50 s, inside a serverless
 * function's own limit) after which it answers 504 rather than being killed.
 */
export function cronRoute<E extends StaffError>(
  name: string,
  program: (request: Request) => Program<Response, E>,
  options: { limit?: Duration.Input } = {},
): (ctx: { request: Request }) => Promise<Response> {
  const limit = options.limit ?? '50 seconds'
  return ({ request }) =>
    serve(
      runtime(),
      name,
      { headers: request.headers, signal: request.signal, session: null },
      Effect.gen(function* () {
        if (!(yield* cronAuthorized(request.headers))) {
          return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        return yield* program(request)
      }).pipe(
        Effect.catch((error) => Effect.succeed(failureResponse(error))),
        Effect.timeoutOrElse({
          duration: limit,
          orElse: () =>
            Effect.succeed(
              Response.json(
                {
                  ok: false,
                  error: `Stopped after ${Duration.format(Duration.fromInputUnsafe(limit))}`,
                },
                { status: 504 },
              ),
            ),
        }),
      ),
    )
}
