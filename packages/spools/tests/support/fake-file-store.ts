/**
 * A stand-in for the file store's HTTP API, holding folders and files in memory.
 * `handle` answers one request; the tests hand it to `installStandIns` (tests/support/run.ts), and
 * `bun tests/support/fake-file-store.ts` serves it on a port for trying the file
 * browser without a real key.
 */
type Folder = { id: string; name: string; parent: string | null; version: number }
type Doc = {
  id: string
  name: string
  folder: string | null
  revision: number
  bytes?: Uint8Array
  metadata: Record<string, unknown>
  created: string
}
type Upload = {
  id: string
  name: string
  folder: string | null
  size: number
  bytes?: Uint8Array
  metadata: Record<string, unknown>
}

export type FakeStore = ReturnType<typeof createFakeStore>

export function createFakeStore(
  options: { key?: string; origin?: string; transport?: 'direct' | 'proxy' } = {},
) {
  const key = options.key ?? 'test-key'
  const origin = options.origin ?? 'https://storage.example'
  const folders = new Map<string, Folder>()
  const docs = new Map<string, Doc>()
  const uploads = new Map<string, Upload>()
  const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = []

  const state = {
    transport: options.transport ?? 'direct',
    complete: ['accepted'] as string[],
    /** The oldest client contract accepted, as the real store's `minimum_version`. */
    minimumClient: '1.1.1',
    /** Whether only requests that look exactly like the store's own SDK's are accepted. */
    sdkOnly: false,
    /** Whether the fuller documents listing is refused, as on an older drive. */
    plainListingOnly: false,
  }

  let seq = 0
  // Ids must look like the store's: UUIDs.
  const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...cors },
    })

  const refuse = (status: number, type: string, code: string, message = code) =>
    json({ error: { type, code, status, message } }, status)

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, PUT, PATCH, OPTIONS',
    'access-control-allow-headers':
      'range, if-range, content-length, content-type, content-md5, idempotency-key',
  }

  const pathOf = (folder: string | null): string => {
    const parts: string[] = []

    for (let at = folder; at; at = folders.get(at)?.parent ?? null) {
      parts.unshift(folders.get(at)?.name ?? '?')
    }

    return parts.join('/')
  }

  const children = (parent: string | null) =>
    [...folders.values()].filter((f) => f.parent === parent)

  const filesIn = (folder: string | null) => [...docs.values()].filter((d) => d.folder === folder)

  const showFolder = (f: Folder) => ({
    id: f.id,
    name: f.name,
    parent_folder_id: f.parent,
    version: String(f.version),
    etag: `"${f.version}"`,
    path: pathOf(f.id),
    folder_count: children(f.id).length,
    file_count: filesIn(f.id).length,
    item_count: children(f.id).length + filesIn(f.id).length,
  })

  const showFile = (d: Doc) => ({
    document_id: d.id,
    path: [pathOf(d.folder), d.name].filter(Boolean).join('/'),
    filename: d.name,
    folder_id: d.folder,
    format: 'file',
    size_bytes: d.bytes?.length ?? 0,
    revision: String(d.revision),
    searchable: false,
  })

  const ensurePath = (path: string) => {
    let parent: string | null = null

    for (const name of path.split('/')) {
      let found: Folder | undefined = children(parent).find((f) => f.name === name)

      if (!found) {
        found = { id: newId(), name, parent, version: 1 }
        folders.set(found.id, found)
      }

      parent = found.id
    }

    return parent as string
  }

  const removeTree = (id: string) => {
    for (const child of children(id)) {
      removeTree(child.id)
    }

    for (const d of filesIn(id)) {
      docs.delete(d.id)
    }

    folders.delete(id)
  }

  const glob = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^$()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
      'i',
    )

  async function handle(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    // Headers and bodies in any form fetch accepts: a plain object or `Headers`; a string, bytes or a stream.
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries())
    const raw = init.body
    const isJson = (headers['content-type'] ?? '').includes('json')

    const text =
      typeof raw === 'string'
        ? raw
        : isJson && (raw instanceof Uint8Array || raw instanceof ArrayBuffer)
          ? new TextDecoder().decode(raw)
          : undefined

    const body = text !== undefined ? JSON.parse(text || '{}') : raw
    const p = u.pathname

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // Transfer and download links carry their own token, like the real store's.
    const put = p.match(/^\/storage\/put\/([\w-]+)$/)

    if (put && method === 'PUT') {
      const up = uploads.get(String(put[1]))

      if (!up) {
        return refuse(404, 'not_found', 'not_found')
      }

      up.bytes = new Uint8Array(init.body as ArrayBuffer)
      return json({ id: up.id, state: 'awaiting_content', uploaded: true })
    }

    const get = p.match(/^\/storage\/get\/([\w-]+)$/)

    if (get && method === 'GET') {
      const doc = docs.get(String(get[1]))

      if (!doc) {
        return new Response('gone', { status: 404, headers: cors })
      }

      return new Response((doc.bytes ?? new Uint8Array()).buffer as ArrayBuffer, {
        headers: { ...cors, 'content-disposition': `inline; filename="${doc.name}"` },
      })
    }

    calls.push({ method, path: p + u.search, body, headers })

    if (headers['authorization'] !== `Bearer ${key}`) {
      return refuse(401, 'auth', 'invalid_credentials')
    }

    if (!headers['flashdrive-client']) {
      return refuse(400, 'invalid', 'client_required')
    }

    // The gate, as the real store applies it to requests made with a key: an old contract version is
    // refused with details; a write that doesn't name the write protocol is refused without any.
    const [clientName = '', clientVersion = ''] = headers['flashdrive-client'].split('/')

    const upgrade = (details: Record<string, string>) =>
      json(
        {
          error: {
            type: 'upgrade',
            code: 'client_upgrade_required',
            status: 426,
            message: 'This client version is no longer supported. Upgrade the client and retry.',
            details,
          },
        },
        426,
      )

    if (clientVersion.localeCompare(state.minimumClient, undefined, { numeric: true }) < 0) {
      return upgrade({
        client: 'sdk',
        version: clientVersion,
        minimum_version: state.minimumClient,
        latest_version: '1.1.2',
      })
    }

    if (method !== 'GET' && headers['flashdrive-write-protocol'] !== 'server-v1') {
      return upgrade({})
    }

    if (
      state.sdkOnly &&
      (clientName !== 'flashdrive-sdk' || headers['flashdrive-source'] !== 'sdk')
    ) {
      return upgrade({})
    }

    const route = p.replace(/^\/v1\/drives\/[\w-]+/, '')

    if (route === '/folders/ensure' && method === 'POST') {
      return json({
        folders: (body.paths as string[]).map((path) => ({ path, id: ensurePath(path) })),
      })
    }

    if (route === '/folders' && method === 'GET') {
      const parent = u.searchParams.get('parent_folder_id')
      return json({ data: children(parent).map(showFolder), next_cursor: null })
    }

    if (route === '/folders' && method === 'POST') {
      const parent = body.parent_folder_id ?? null

      if (children(parent).some((f) => f.name === body.name)) {
        return refuse(409, 'conflict', 'duplicate_name')
      }

      const folder = { id: newId(), name: body.name, parent, version: 1 }
      folders.set(folder.id, folder)
      return json(showFolder(folder))
    }

    const folder = route.match(/^\/folders\/([\w-]+)$/)

    if (folder) {
      const f = folders.get(String(folder[1]))

      if (!f) {
        return refuse(404, 'not_found', 'folder_not_found')
      }

      if (method === 'GET') {
        return json(showFolder(f))
      }

      if (headers['if-match'] !== `"${f.version}"`) {
        return refuse(412, 'precondition', 'stale_version')
      }

      if (method === 'PATCH') {
        const parent = 'parent_folder_id' in body ? body.parent_folder_id : f.parent
        const name = body.name ?? f.name

        if (children(parent).some((other) => other.id !== f.id && other.name === name)) {
          return refuse(409, 'conflict', 'duplicate_name')
        }

        Object.assign(f, { name, parent, version: f.version + 1 })
        return json(showFolder(f))
      }

      if (method === 'DELETE') {
        if (u.searchParams.get('recursive') !== 'true' && showFolder(f).item_count > 0) {
          return refuse(409, 'conflict', 'folder_not_empty')
        }

        removeTree(f.id)
        return json({ operation_id: newId(), state: 'running', documents_total: 0 })
      }
    }

    if (/^\/folder-deletions\/[\w-]+\/step$/.test(route)) {
      return json({ state: 'finished' })
    }

    if (route === '/files' && method === 'GET') {
      const pattern = u.searchParams.get('pattern')
      const where = u.searchParams.get('folder_id')

      const found = pattern
        ? [...docs.values()].filter((d) => glob(pattern).test(d.name))
        : filesIn(where === 'root' ? null : where)

      return json({ data: found.map(showFile), next_cursor: null, complete: true })
    }

    if (route === '/documents' && method === 'GET') {
      if (state.plainListingOnly) {
        return refuse(409, 'conflict', 'not_supported_on_this_drive')
      }

      const where = u.searchParams.get('folder_id')
      return json({
        data: filesIn(where === 'root' ? null : where).map((d) => ({
          id: d.id,
          filename: d.name,
          source_bytes: d.bytes?.length ?? 0,
          latest_revision: String(d.revision),
          folder_id: d.folder,
          metadata: d.metadata,
          created_at: d.created,
        })),
        next_cursor: null,
      })
    }

    if (route === '/uploads' && method === 'POST') {
      if (String(body.filename).startsWith('full')) {
        return refuse(409, 'quota', 'storage_quota_exceeded')
      }

      if (body.folder_id && !folders.has(body.folder_id)) {
        return refuse(404, 'not_found', 'folder_not_found')
      }

      const up = {
        id: newId(),
        name: body.filename,
        folder: body.folder_id ?? null,
        size: body.size_bytes,
        metadata: body.metadata ?? {},
      }

      uploads.set(up.id, up)
      return json({ id: up.id, state: 'awaiting_content' })
    }

    const upload = route.match(/^\/uploads\/([\w-]+)(\/transfer|\/complete|\/content)?$/)

    if (upload) {
      const up = uploads.get(String(upload[1]))

      if (!up) {
        return refuse(404, 'not_found', 'upload_not_found')
      }

      if (upload[2] === '/transfer') {
        return state.transport === 'direct'
          ? json({
              transport: 'direct',
              url: `${origin}/storage/put/${up.id}`,
              headers: { 'Content-Type': 'application/octet-stream' },
            })
          : json({ transport: 'proxy' })
      }

      if (upload[2] === '/content' && method === 'PUT') {
        up.bytes = new Uint8Array(
          init.body instanceof ArrayBuffer
            ? init.body
            : await new Response(init.body).arrayBuffer(),
        )

        return json({ id: up.id, state: 'awaiting_content', uploaded: true })
      }

      // `complete` answers with the first state; each later read moves to the next.
      const next =
        state.complete.length > 1 ? String(state.complete.shift()) : String(state.complete[0])

      if (next !== 'accepted') {
        return json({ id: up.id, state: next })
      }

      docs.set(up.id, {
        id: up.id,
        name: up.name,
        folder: up.folder,
        revision: 1,
        bytes: up.bytes,
        metadata: up.metadata,
        created: new Date().toISOString(),
      })

      return json({
        id: up.id,
        state: 'accepted',
        finalization: { outcome: 'committed', original: { id: up.id }, recovery: null },
      })
    }

    const doc = route.match(/^\/documents\/([\w-]+)(\/source\/link)?$/)

    if (doc) {
      const d = docs.get(String(doc[1]))

      if (!d) {
        return refuse(404, 'not_found', 'document_not_found')
      }

      if (doc[2]) {
        return json({ url: `${origin}/storage/get/${d.id}`, expires_at: 'soon' })
      }

      if (method === 'GET') {
        return json({ id: d.id, latest_revision: String(d.revision), folder_id: d.folder })
      }

      if (headers['if-match'] !== `"${d.revision}"`) {
        return refuse(412, 'precondition', 'stale_version')
      }

      if (method === 'DELETE') {
        docs.delete(d.id)
        return json({ operation_id: newId() })
      }

      if (method === 'PATCH') {
        const where = 'folder_id' in body ? body.folder_id : d.folder
        const name = body.filename ?? d.name

        if (filesIn(where).some((other) => other.id !== d.id && other.name === name)) {
          return refuse(409, 'conflict', 'duplicate_name')
        }

        Object.assign(d, { name, folder: where, revision: d.revision + 1 })
        return json({ operation_id: newId() })
      }
    }

    return refuse(404, 'not_found', 'not_found', `${method} ${p}`)
  }

  return {
    handle,
    calls,
    state,
    folders,
    docs,
    pathOf,
    tree: () => [...folders.values()].map((f) => pathOf(f.id)).sort(),
  }
}

// `bun tests/support/fake-file-store.ts [port]`: serve it for a browser.
if (import.meta.main) {
  const port = Number(process.argv[2] ?? 3998)
  const fake = createFakeStore({ key: 'local-fake-key', origin: `http://localhost:${port}` })

  Bun.serve({
    port,
    async fetch(req) {
      const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        ? undefined
        : (req.headers.get('content-type') ?? '').includes('json')
          ? await req.text()
          : await req.arrayBuffer()

      // A beat, so progress is visible.
      if (req.method === 'PUT') {
        await Bun.sleep(400)
      }

      return fake.handle(req.url, {
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body,
      })
    },
  })

  console.log(`fake file store on http://localhost:${port} (key: local-fake-key)`)
}
