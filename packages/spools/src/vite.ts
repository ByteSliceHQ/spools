/**
 * What a Spool's `vite.config.ts` adds for the host it is built on.
 *
 *   import { vercel } from '@swirls/spools/vite'
 *
 *   plugins: [tailwindcss(), tanstackStart(), vercel(), viteReact()]
 *
 * Build tooling only: nothing here is imported by the app or the server.
 */
import type { PluginOption } from 'vite'

/**
 * Packages that are native, so they are copied into the function whole instead of
 * bundled, including the platform build installed on the host.
 */
const NATIVE = ['@cipherstash/stack*', '@cipherstash/protect-ffi*', '@cipherstash/auth*']

export type VercelOptions = {
  /** More packages to copy into the function whole (a native module of your own). */
  traceDeps?: string[]
  /** Build for Vercel whatever the environment says. By default only when `VERCEL` is set. */
  force?: boolean
}

/**
 * Packages the app for Vercel as a Bun function in `.vercel/output`, which is what
 * Vercel's TanStack Start preset expects. It does nothing unless `VERCEL` is set, as it
 * is in every Vercel build, so every other build stays the plain `dist/` server that
 * `server.prod.ts` and the Dockerfile run.
 *
 * Needs `nitro` installed in the app. Put it after `tanstackStart()`.
 */
export async function vercel({ traceDeps = [], force = false }: VercelOptions = {}): Promise<
  PluginOption[]
> {
  if (!force && !process.env['VERCEL']) {
    return []
  }

  const { nitro } = await import('nitro/vite')

  return [
    nitro({
      preset: 'vercel',
      vercel: { functions: { runtime: 'bun1.x' } },
      traceDeps: [...NATIVE, ...traceDeps],
    }),
  ]
}
