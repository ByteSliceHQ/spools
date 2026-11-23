import { Context, Effect, Layer } from 'effect'
import { z } from 'zod'

import type { Adapter } from './adapter'
import { VaultError } from './errors'
import { type Json, jsonValue } from './json'
import { policies, withPolicy } from './policies'

/**
 * The vault: encryption for secrets the CRM has to keep, such as a teammate's
 * OAuth tokens. They are sealed in this process before they reach the database,
 * so a copy of the database alone can't be used to read anyone's mailbox.
 *
 * Adapters are in src/adapters/vault/. Without one (or without its keys) the
 * vault refuses to seal anything: there is no plaintext fallback.
 *
 * A secret is sealed for its owner: the row it is stored on, named by whoever
 * seals it. The name is encrypted with the secret, and opening it for anything
 * else is refused. So someone who can write to the database but has no key
 * can't move one person's tokens onto a row of their own and have the CRM use
 * them. This is the same for every cipher; an adapter only encrypts.
 */

export { VaultError }

/** Turns a string into ciphertext (as text for a database column) and back. */
export type Cipher = {
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
}

const asVaultError = (cause: unknown, fallback: string) =>
  cause instanceof VaultError ? cause : new VaultError({ message: fallback })

/** What is encrypted: the secret, and who it is for. */
const Sealed = z.object({ 'spools.sealed': z.literal(1), owner: z.string(), value: z.unknown() })

/** A secret that was opened. */
export type Opened<T> = {
  readonly value: T
  /**
   * False for a secret sealed before secrets were tied to their owner. It is
   * what it says, but nothing ties it to this row: seal it again.
   */
  readonly bound: boolean
}

export class Vault extends Context.Service<
  Vault,
  {
    /**
     * Encrypt a JSON-serialisable value for storage, for one owner: a name for
     * the row it will be stored on, which must never be another row's.
     */
    readonly seal: (value: Json, owner: string) => Effect.Effect<string, VaultError>
    /**
     * Decrypt a value stored with `seal` for the same owner, and check it is
     * the shape expected. A secret sealed for another owner is refused.
     */
    readonly open: <T>(
      sealed: string,
      owner: string,
      shape: z.ZodType<T>,
    ) => Effect.Effect<Opened<T>, VaultError>
    /** Why secrets can't be stored, in words for whoever runs the CRM, or null when they can. */
    readonly problem: Effect.Effect<string | null>
  }
>()('spools/Vault') {
  /** A vault over a cipher, for adapters. `service` is what a timeout message calls it. */
  static readonly make = (options: {
    cipher: Effect.Effect<Cipher, VaultError>
    problem: Effect.Effect<string | null>
    service?: string
  }) => {
    const policy = options.service
      ? { ...policies.vault, service: options.service }
      : policies.vault

    const limited = <A>(self: Effect.Effect<A, VaultError>) =>
      self.pipe(
        withPolicy(policy, () => false),
        Effect.catchTag('Timeout', (timeout) =>
          Effect.fail(new VaultError({ message: timeout.message })),
        ),
      )

    return Vault.of({
      problem: options.problem,
      seal: (value, owner) =>
        Effect.flatMap(options.cipher, (c) =>
          Effect.tryPromise({
            try: () => c.encrypt(JSON.stringify({ 'spools.sealed': 1, owner, value })),
            catch: (cause) => asVaultError(cause, 'Could not encrypt the secret'),
          }),
        ).pipe(limited, Effect.withSpan('Vault.seal')),
      open: <T>(sealed: string, owner: string, shape: z.ZodType<T>) =>
        Effect.flatMap(options.cipher, (c) =>
          Effect.tryPromise({
            try: () => c.decrypt(sealed),
            catch: (cause) => asVaultError(cause, 'Could not decrypt the secret'),
          }),
        ).pipe(
          limited,
          Effect.flatMap((plaintext) =>
            Effect.try({
              try: () => jsonValue.parse(JSON.parse(plaintext)),
              catch: () => new VaultError({ message: 'Decrypted secret is not valid JSON' }),
            }),
          ),
          Effect.flatMap((parsed): Effect.Effect<Opened<T>, VaultError> => {
            const sealedFor = Sealed.safeParse(parsed)

            if (sealedFor.success && sealedFor.data.owner !== owner) {
              return Effect.fail(
                new VaultError({ message: 'Stored secret belongs to something else' }),
              )
            }

            const value = shape.safeParse(sealedFor.success ? sealedFor.data.value : parsed)

            return value.success
              ? Effect.succeed({ value: value.data, bound: sealedFor.success })
              : Effect.fail(new VaultError({ message: 'Stored secret is not what was expected' }))
          }),
          Effect.withSpan('Vault.open'),
        ),
    })
  }

  /** A Spool with no vault: nothing is sealed, and it says so. */
  static readonly none = Layer.sync(Vault, () => {
    const problem = 'No vault is set up to encrypt stored secrets'
    return Vault.make({
      cipher: Effect.fail(new VaultError({ message: problem })),
      problem: Effect.succeed(problem),
    })
  })

  /** A vault over a stand-in cipher (tests). */
  static readonly layerTest = (cipher: Cipher) =>
    Layer.succeed(
      Vault,
      Vault.make({ cipher: Effect.succeed(cipher), problem: Effect.succeed(null) }),
    )
}

export type VaultAdapter = Adapter<Vault>
