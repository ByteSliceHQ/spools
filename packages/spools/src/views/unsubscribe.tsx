import { getRouteApi, useLoaderData } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'

import { unsubscribeFn } from '../server/email.functions'

const route = getRouteApi('/unsubscribe')

export function Unsubscribe(): ReactNode {
  const { t } = route.useSearch()
  const brand = useLoaderData({ from: '__root__' })
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <section className="w-full max-w-md text-center">
        <p className="text-sm font-medium text-zinc-500">{brand.name}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Unsubscribe</h1>
        {state === 'done' ? (
          <p className="mt-4 text-zinc-600">
            You're unsubscribed. You won't receive any more of these emails.
          </p>
        ) : !t ? (
          <p className="mt-4 text-zinc-600">This link is missing its token.</p>
        ) : (
          <>
            <p className="mt-4 text-zinc-600">Stop receiving marketing emails from us?</p>
            {state === 'error' && <p className="mt-4 text-sm text-red-600">{error}</p>}
            <button
              type="button"
              onClick={async () => {
                try {
                  await unsubscribeFn({ data: { token: t } })
                  setState('done')
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Something went wrong')
                  setState('error')
                }
              }}
              className="mt-8 rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Unsubscribe
            </button>
          </>
        )}
      </section>
    </main>
  )
}
