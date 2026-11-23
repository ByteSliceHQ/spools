import { type AnyRouter, type ErrorComponentProps, useRouter } from '@tanstack/react-router'

import { forgetCrmSession } from './session'

/** Router options every Spool uses. Spread them into `createRouter` in src/router.tsx. */
export const spoolRouter = {
  scrollRestoration: true,
  defaultPreload: 'intent',
  // A page seen in the last few seconds is shown as it was, without asking again.
  // Older than that, it is still shown at once and refreshed behind the scenes.
  // Every change made in the app calls `router.invalidate()`, which reloads regardless.
  defaultStaleTime: 15_000,
  // Data fetched when a link is hovered is good for the click that follows.
  defaultPreloadStaleTime: 30_000,
  defaultErrorComponent: ErrorPage,
  defaultNotFoundComponent: NotFoundPage,
} as const

/**
 * "Something changed": `router.invalidate()` also drops what the browser
 * remembers between pages (the session with its favourites and task count,
 * relation titles).
 */
export function forgetWhenChanged<R extends AnyRouter>(router: R): R {
  const invalidate = router.invalidate

  router.invalidate = (opts) => {
    forgetCrmSession()
    return invalidate(opts)
  }

  return router
}

function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <div className="mx-auto max-w-xl p-16 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-3 text-sm whitespace-pre-wrap text-zinc-600">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <button
        type="button"
        onClick={() => {
          // Ask afresh who is signed in: if the session ended, this leads to the sign-in page.
          reset()
          void router.invalidate()
        }}
        className="mt-6 rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50"
      >
        Try again
      </button>
    </div>
  )
}

function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl p-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <a href="/" className="text-brand-600 mt-4 inline-block text-sm hover:underline">
        Go home
      </a>
    </div>
  )
}
