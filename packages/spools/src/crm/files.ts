/**
 * Files: the rules the server and the browser share. Pure (no Zod, no
 * server imports), so the Files tab can import it.
 *
 * The bytes live in the Spool's file store (src/server/runtime/files.ts);
 * src/server/files.ts talks to it.
 */

/**
 * The largest file the CRM will upload. Above this the store needs a multipart
 * transfer, and the browser has to hold the file in memory to hash it. Bigger
 * files go into the drive directly (it mounts as a folder) and stay out of the CRM.
 */
export const MAX_UPLOAD_BYTES = 1_000_000_000

/** What the shared library is called unless the config names it. */
export const LIBRARY_LABEL = 'Company files'

/** How many files one drop or pick may add. */
export const MAX_FILES_PER_UPLOAD = 50

/** Characters a file or folder name can't hold in a drive that also mounts on macOS, Linux and Windows. */
const FORBIDDEN = /[/\\:*?"<>|]/g

// Control characters, U+007F included: they can't appear in a file name on every platform a drive mounts on.
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
)

/**
 * A name that is safe as one path segment: no separators or control characters,
 * no leading dots (hidden and agent-instruction folders), no trailing dots or
 * spaces, at most `max` characters. Empty input becomes `fallback`.
 */
export function safeName(name: string, fallback = 'Untitled', max = 120): string {
  const cleaned = name
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(FORBIDDEN, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim()

  if (!cleaned) {
    return fallback
  }

  if (cleaned.length <= max) {
    return cleaned
  }

  // Keep the extension when shortening a file name.
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : ''
  return `${cleaned.slice(0, max - ext.length).trimEnd()}${ext}`
}

/** Whether a configured folder name can be used as it is written. */
export const isFolderName = (name: string): boolean =>
  name.length > 0 && name.length <= 60 && safeName(name, '', 60) === name

/** FlashDrive reads and indexes these; everything else is kept as it is. */
const INDEXED = new Map<string, 'pdf' | 'docx' | 'txt' | 'md'>([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['txt', 'txt'],
  ['md', 'md'],
])

/** FlashDrive's `format` for a file name. */
export function storeFormat(name: string): 'pdf' | 'docx' | 'txt' | 'md' | 'file' {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  // A Map, not an object: an extension such as `.constructor` must not find what every object inherits.
  return INDEXED.get(ext) ?? 'file'
}

/** "1.4 MB", "820 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return ''
  }

  if (bytes < 1000) {
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }

  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** What an upload must satisfy before the server is asked for anything. Returns why not, or null. */
export function uploadProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) {
    return `${file.name} is empty`
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}; the largest file you can add here is ${formatBytes(MAX_UPLOAD_BYTES)}`
  }

  return null
}
