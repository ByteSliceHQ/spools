import { Effect, Layer, Predicate } from 'effect'

import * as config from '../../../server/runtime/config'
import { type Cipher, Vault, type VaultAdapter, VaultError } from '../../../server/runtime/vault'

/**
 * Secrets encrypted with CipherStash (https://cipherstash.com) in this process,
 * each under its own key from ZeroKMS.
 *
 *   CS_WORKSPACE_CRN, CS_CLIENT_ID, CS_CLIENT_KEY, CS_CLIENT_ACCESS_KEY
 */

const VARIABLES = [
  'CS_WORKSPACE_CRN',
  'CS_CLIENT_ID',
  'CS_CLIENT_KEY',
  'CS_CLIENT_ACCESS_KEY',
] as const

/** True when every CipherStash credential is set in `env`. */
export const cipherStashConfigured = (env: Record<string, string | undefined>): boolean =>
  VARIABLES.every((name) => !!env[name])

/**
 * A JSON value: what an encrypted payload is kept as, and read back from. A
 * member that is `undefined` is one JSON leaves out, as the SDK's own payload
 * type has them.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined }

/** What CipherStash answers with: the data, or why not. */
type Answer = {
  data?: unknown
  failure?: { type: string; message: string } | undefined
}

/**
 * The part of the CipherStash client this adapter uses. Declared as methods, so
 * the SDK's own client, whose parameters are its own types, is one of these.
 */
export type CipherStashClient = {
  encrypt(plaintext: string, where: { table: unknown; column: unknown }): PromiseLike<Answer>
  decrypt(payload: Json): PromiseLike<Answer>
}

/**
 * A cipher over a CipherStash client: what is stored is the client's encrypted
 * payload as JSON. Exported for tests, which stand in for the client; nothing
 * else here talks to CipherStash.
 */
export function cipherOver(
  client: CipherStashClient,
  where: { table: unknown; column: unknown },
): Cipher {
  return {
    async encrypt(plaintext) {
      const result = await client.encrypt(plaintext, where)

      if (result.failure) {
        throw new VaultError({ message: `Could not encrypt: ${result.failure.message}` })
      }

      return JSON.stringify(result.data)
    },
    async decrypt(ciphertext) {
      // What JSON.parse reads is JSON.
      let payload: Json

      try {
        payload = JSON.parse(ciphertext)
      } catch {
        throw new VaultError({ message: 'Stored secret is not an encrypted payload' })
      }

      const result = await client.decrypt(payload)

      if (result.failure) {
        throw new VaultError({ message: `Could not decrypt: ${result.failure.message}` })
      }

      if (!Predicate.isString(result.data)) {
        throw new VaultError({ message: 'Decrypted secret has an unexpected type' })
      }

      return result.data
    },
  }
}

/** The SDK is imported on first use: it carries a native module, and an app that never seals anything shouldn't load it. */
async function cipherStash(): Promise<Cipher> {
  const [{ Encryption }, { encryptedTable, types }] = await Promise.all([
    import('@cipherstash/stack'),
    import('@cipherstash/stack/v3'),
  ])

  // Encrypt-only: tokens are looked up by user and provider, never searched by value.
  const integrations = encryptedTable('integrations', { credentials: types.Text('credentials') })
  const client = await Encryption({ schemas: [integrations] })
  return cipherOver(client, { table: integrations, column: integrations.credentials })
}

const starting = (cause: unknown) =>
  cause instanceof VaultError
    ? cause
    : new VaultError({ message: 'Could not reach CipherStash to set up encryption' })

/** Set up the first time a secret is sealed or opened, and again after a failed start. */
export const cipherstash = (): VaultAdapter => ({
  id: 'cipherstash',
  label: 'CipherStash',
  features: [{ name: 'Integrations: encrypted token storage (CipherStash)', vars: VARIABLES }],
  layer: Layer.sync(Vault, () => {
    let ready: Promise<Cipher> | undefined

    const cipher = Effect.gen(function* () {
      if (!cipherStashConfigured(yield* config.environment)) {
        return yield* new VaultError({
          message: `Encryption isn't set up, so secrets can't be stored. Set ${VARIABLES.join(', ')} (see docs/integrations.md).`,
        })
      }

      ready ??= cipherStash().catch((cause) => {
        ready = undefined // let the next call try again, e.g. after credentials are fixed
        throw starting(cause)
      })

      const started = ready
      return yield* Effect.tryPromise({ try: () => started, catch: starting })
    })

    return Vault.make({
      cipher,
      service: 'CipherStash',
      problem: Effect.map(config.environment, (env) =>
        cipherStashConfigured(env) ? null : 'CipherStash encryption is not set up (CS_* variables)',
      ),
    })
  }),
})
