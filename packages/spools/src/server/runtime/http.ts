import { Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'

/**
 * HTTP to outside services goes through Effect's `HttpClient` (`effect/http`),
 * never `fetch` directly. A request is aborted when its program is
 * interrupted (the browser went away, a time limit in policies.ts ran out),
 * and services shape requests and read answers with `HttpClientRequest` and
 * `HttpClientResponse`.
 *
 * The client is Effect's fetch client. Tests replace the `fetch` underneath
 * it (`httpLayer(fake)`), so a stand-in such as src/testing/fake-file-store.ts
 * answers every outside call while the services run exactly as they do live.
 */

/** A fetch-shaped function: the global one, or a stand-in. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const asGlobalFetch = (impl: Fetch): typeof globalThis.fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      impl(input instanceof Request ? input.url : String(input), init),
    { preconnect: () => {} },
  )

/** The HTTP client every outside service uses: through `impl` when given, else the global fetch. */
export const httpLayer = (impl?: Fetch) =>
  impl
    ? // The client reads `Fetch` from the running program, so it is provided beside the client, not under it.
      Layer.merge(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, asGlobalFetch(impl)))
    : FetchHttpClient.layer
