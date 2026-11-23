/**
 * Production server: `bun run build && bun run start`.
 * Serves the built client assets and hands every other request to TanStack Start.
 */
import { join, normalize } from 'node:path'

import { z } from 'zod'

import { clientIp } from '@swirls/spools/server/client-ip'

const clientDir = join(import.meta.dir, 'dist/client')
const serverEntry = join(import.meta.dir, 'dist/server/server.js')

type ServerEntry = { default: { fetch(request: Request): Promise<Response> } }

/** The build's default export is TanStack Start's request handler: an object with `fetch`. */
const serverEntryShape = z.object({ default: z.object({ fetch: z.instanceof(Function) }) })

const isServerEntry = (module: unknown): module is ServerEntry =>
  serverEntryShape.safeParse(module).success

const built: unknown = await import(serverEntry)

if (!isServerEntry(built)) {
  throw new Error(`${serverEntry} has no request handler. Run \`bun run build\` first.`)
}

const { default: app } = built

const port = Number(process.env['PORT'] ?? 3000)
const trustedHops = Math.max(0, Number.parseInt(process.env['TRUST_PROXY'] ?? '0', 10) || 0)

async function staticFile(pathname: string): Promise<Response | null> {
  if (pathname === '/' || pathname.endsWith('/')) {
    return null
  }

  let path: string

  try {
    path = normalize(join(clientDir, decodeURIComponent(pathname)))
  } catch {
    return null // not a valid address
  }

  if (!path.startsWith(`${clientDir}/`)) {
    return null
  } // path traversal

  const file = Bun.file(path)

  if (!(await file.exists())) {
    return null
  }

  const immutable = pathname.startsWith('/assets/')
  return new Response(file, {
    headers: {
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    },
  })
}

const server = Bun.serve({
  port,
  hostname: process.env['HOST'] ?? '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return new Response('ok')
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = await staticFile(url.pathname)

      if (asset) {
        return asset
      }
    }

    // Normalise X-Forwarded-For to the real client IP before the app sees it.
    // Proxies append to the header, so everything left of the
    // hops we trust is client-controlled: take the address TRUST_PROXY hops from the right.
    const headers = new Headers(request.headers)

    const ip = clientIp(
      request.headers.get('x-forwarded-for'),
      server.requestIP(request)?.address,
      trustedHops,
    )

    if (ip) {
      headers.set('x-forwarded-for', ip)
    } else {
      headers.delete('x-forwarded-for')
    }

    return app.fetch(new Request(request, { headers }))
  },
})

console.log(`Listening on http://${server.hostname}:${server.port}`)

/**
 * On SIGTERM (a deploy, `docker stop`) or Ctrl-C: stop taking requests, let the
 * ones in flight finish (up to 10 s), then dispose the Effect runtime, which
 * closes the database pool. The runtime lives inside the built server, so it
 * is reached by the key src/server/runtime/app.ts keeps it under.
 */
const runtimeKey = Symbol.for('crm.runtime')
// Whatever is on the global object under the runtime's key is checked before it is used.
const globals: typeof globalThis & { [runtimeKey]?: unknown } = globalThis
const disposableShape = z.object({ dispose: z.instanceof(Function) })

const isDisposable = (value: unknown): value is { dispose(): Promise<void> } =>
  disposableShape.safeParse(value).success

async function shutdown(signal: string) {
  console.log(`[server] ${signal}: finishing requests in flight`)

  const runtime = globals[runtimeKey]

  const drained = server.stop()
  await Promise.race([drained, Bun.sleep(10_000)])

  if (isDisposable(runtime)) {
    await runtime.dispose()
  }

  process.exit(0)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
