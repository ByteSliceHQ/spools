import { Effect, Layer } from 'effect'

import * as config from '../../../server/runtime/config'
import { type Cipher, Vault, type VaultAdapter, VaultError } from '../../../server/runtime/vault'

/**
 * Secrets encrypted with AES-256-GCM under a key from the environment: no
 * outside service.
 *
 *   VAULT_KEY        32 random bytes, base64. `openssl rand -base64 32`
 *   VAULT_OLD_KEYS   optional: keys VAULT_KEY replaced, comma-separated, still used to open what they sealed
 *
 * The key is as valuable as everything sealed with it: anyone who has it and a
 * copy of the database can read the stored tokens. CipherStash gives each value
 * its own key and keeps the root of them elsewhere; use it when that matters.
 *
 * Sealed values are `v1.<key id>.<nonce>.<ciphertext>`, base64url. A fresh
 * 96-bit nonce is drawn for each value, and the version and key id are
 * authenticated with it, so neither can be swapped.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'))

type Key = { id: string; key: CryptoKey }

/** What is wrong with something given as a key that isn't one. */
const NOT_A_KEY = 'must be 32 random bytes, base64 (openssl rand -base64 32)'

/** A key from its base64 form, or null when it isn't one (`NOT_A_KEY`). The id is a hash, so it says nothing about the key. */
async function importKey(encoded: string): Promise<Key | null> {
  const raw = new Uint8Array(Buffer.from(encoded.trim(), 'base64'))

  if (raw.byteLength !== 32) {
    return null
  }

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  return {
    id: b64url(digest.slice(0, 6)),
    key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
  }
}

const associated = (id: string) => new TextEncoder().encode(`spools-vault.v1.${id}`)

/** The cipher for a current key and any it replaced. Exported for tests. */
export async function aesCipher(current: string, old: readonly string[] = []): Promise<Cipher> {
  const main = await importKey(current)

  if (!main) {
    throw new VaultError({ message: `VAULT_KEY ${NOT_A_KEY}` })
  }

  const keys = new Map([[main.id, main.key]])

  for (const encoded of old) {
    const key = await importKey(encoded)

    if (!key) {
      throw new VaultError({ message: `VAULT_OLD_KEYS: each ${NOT_A_KEY}` })
    }

    keys.set(key.id, key.key)
  }

  return {
    async encrypt(plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12))

      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: associated(main.id) },
        main.key,
        new TextEncoder().encode(plaintext),
      )

      return `v1.${main.id}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`
    },
    async decrypt(ciphertext) {
      const [version, id, iv, sealed, ...rest] = ciphertext.split('.')

      if (version !== 'v1' || !id || !iv || !sealed || rest.length > 0) {
        throw new VaultError({ message: 'Stored secret is not one this vault sealed' })
      }

      const key = keys.get(id)

      if (!key) {
        throw new VaultError({
          message: 'Stored secret was sealed with a key this CRM no longer has (VAULT_OLD_KEYS)',
        })
      }

      try {
        const opened = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytesOf(iv), additionalData: associated(id) },
          key,
          bytesOf(sealed),
        )

        return new TextDecoder().decode(opened)
      } catch {
        throw new VaultError({
          message: 'Stored secret could not be opened: it was changed, or the key is wrong',
        })
      }
    },
  }
}

const problemWith = (key: string | undefined): string | null => {
  if (!key) {
    return 'VAULT_KEY is not set (openssl rand -base64 32)'
  }

  return Buffer.from(key.trim(), 'base64').byteLength === 32
    ? null
    : 'VAULT_KEY must be 32 random bytes, base64 (openssl rand -base64 32)'
}

export const aes = (): VaultAdapter => ({
  id: 'aes',
  label: 'The vault',
  features: [
    {
      name: 'Integrations: encrypted token storage (AES)',
      vars: ['VAULT_KEY'],
      check: (env) => problemWith(env['VAULT_KEY']),
    },
  ],
  layer: Layer.sync(Vault, () => {
    const cipher = Effect.gen(function* () {
      const env = yield* config.environment
      const problem = problemWith(env['VAULT_KEY'])

      if (problem) {
        return yield* new VaultError({
          message: `Encryption isn't set up, so secrets can't be stored. ${problem}`,
        })
      }

      const old = (env['VAULT_OLD_KEYS'] ?? '').split(',').filter((k) => k.trim())
      return yield* Effect.tryPromise({
        try: () => aesCipher(env['VAULT_KEY'] ?? '', old),
        catch: (cause) =>
          cause instanceof VaultError
            ? cause
            : new VaultError({ message: 'Could not set up encryption' }),
      })
    })

    return Vault.make({
      cipher,
      service: 'The vault',
      problem: Effect.map(config.environment, (env) => problemWith(env['VAULT_KEY'])),
    })
  }),
})
