import { describe, expect, test } from 'bun:test'

import { Layer } from 'effect'
import { z } from 'zod'

import { aes, aesCipher } from '../../src/adapters/vault/aes/server'
import { httpLayer } from '../../src/server/runtime/http'
import { Vault, VaultError } from '../../src/server/runtime/vault'
import { spool } from '../../src/server/spool'
import { testRuntime, withEnv } from '../support/run'

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

describe('the AES vault', () => {
  test('opens what it sealed, and what is stored gives nothing away', async () => {
    const cipher = await aesCipher(key())
    const secret = JSON.stringify({ accessToken: 'ya29.secret' })
    const sealed = await cipher.encrypt(secret)
    expect(sealed).not.toContain('ya29')
    expect(sealed).toMatch(/^v1\.[\w-]{8}\.[\w-]{16}\.[\w-]+$/)
    expect(await cipher.decrypt(sealed)).toBe(secret)
  })

  test('the same value is never sealed the same way twice', async () => {
    const cipher = await aesCipher(key())
    const sealed = await Promise.all(Array.from({ length: 50 }, () => cipher.encrypt('same')))
    expect(new Set(sealed).size).toBe(50)
    expect(new Set(sealed.map((s) => s.split('.')[2])).size).toBe(50)
  })

  test('a change to any part is refused', async () => {
    const cipher = await aesCipher(key())
    const sealed = await cipher.encrypt('secret')
    const parts = sealed.split('.')

    const flipped = (i: number) => {
      const bytes = Buffer.from(parts[i] as string, 'base64url')
      bytes[0] = (bytes[0] as number) ^ 1
      return parts.map((p, at) => (at === i ? bytes.toString('base64url') : p)).join('.')
    }

    for (const i of [1, 2, 3]) {
      await expect(cipher.decrypt(flipped(i))).rejects.toBeInstanceOf(VaultError)
    }

    for (const odd of ['', '{}', 'v2.a.b.c', `${sealed}.x`, parts.slice(0, 3).join('.')]) {
      await expect(cipher.decrypt(odd)).rejects.toThrow('not one this vault sealed')
    }
  })

  test("another key can't open it; a replaced key still can when it is kept", async () => {
    const [first, second] = [key(), key()]
    const sealed = await (await aesCipher(first)).encrypt('secret')
    await expect((await aesCipher(second)).decrypt(sealed)).rejects.toThrow('no longer has')
    const rotated = await aesCipher(second, [first])
    expect(await rotated.decrypt(sealed)).toBe('secret')
    // New values are sealed with the new key.
    expect((await rotated.encrypt('secret')).split('.')[1]).not.toBe(sealed.split('.')[1])
  })

  test("a key that isn't 32 bytes is refused, without being repeated in the message", async () => {
    for (const bad of ['short', Buffer.alloc(16).toString('base64'), 'not base64 at all !!']) {
      const error = await aesCipher(bad).catch((e: unknown) => e as Error)
      expect((error as Error).message).toContain('VAULT_KEY must be 32 random bytes')
      expect((error as Error).message).not.toContain(bad)
    }
  })

  test('without a key nothing is sealed, and it says what to set', async () => {
    const saved = process.env['VAULT_KEY']
    delete process.env['VAULT_KEY']

    const rt = testRuntime(
      aes().layer.pipe(
        Layer.provide(spool().database.layer),
        Layer.provide(httpLayer()),
        Layer.provide(withEnv({})),
      ),
    )

    try {
      expect(await rt.runPromise(Vault.use((v) => v.problem))).toContain('VAULT_KEY is not set')

      await expect(
        rt.runPromise(Vault.use((v) => v.seal({ token: 'x' }, 'row 1'))),
      ).rejects.toThrow("Encryption isn't set up")

      process.env['VAULT_KEY'] = key()
      const sealed = await rt.runPromise(Vault.use((v) => v.seal({ token: 'x' }, 'row 1')))
      const Token = z.object({ token: z.string() })

      expect(await rt.runPromise(Vault.use((v) => v.open(sealed, 'row 1', Token)))).toEqual({
        value: { token: 'x' },
        bound: true,
      })
    } finally {
      await rt.dispose()

      if (saved === undefined) {
        delete process.env['VAULT_KEY']
      } else {
        process.env['VAULT_KEY'] = saved
      }
    }
  })
})

test('a Spool with no vault stores no secrets', async () => {
  const rt = testRuntime(Vault.none)
  expect(await rt.runPromise(Vault.use((v) => v.problem))).toContain('No vault')

  await expect(rt.runPromise(Vault.use((v) => v.seal('x', 'row')))).rejects.toBeInstanceOf(
    VaultError,
  )

  await rt.dispose()
})

describe('a secret and its owner', () => {
  const Token = z.object({ token: z.string() })

  const vault = async () => {
    const cipher = await aesCipher(key())
    const rt = testRuntime(Vault.layerTest(cipher))
    return { cipher, rt }
  }

  test('a secret sealed for one row is refused for any other', async () => {
    const { rt } = await vault()

    try {
      const sealed = await rt.runPromise(Vault.use((v) => v.seal({ token: 'ada' }, "ada's row")))

      // Someone who can write to the database copies Ada's sealed tokens onto a row of their own.
      await expect(
        rt.runPromise(Vault.use((v) => v.open(sealed, "mallory's row", Token))),
      ).rejects.toThrow('belongs to something else')

      expect(await rt.runPromise(Vault.use((v) => v.open(sealed, "ada's row", Token)))).toEqual({
        value: { token: 'ada' },
        bound: true,
      })
    } finally {
      await rt.dispose()
    }
  })

  test('the owner is encrypted with the secret, not stored beside it', async () => {
    const { rt } = await vault()

    try {
      const sealed = await rt.runPromise(Vault.use((v) => v.seal({ token: 'x' }, 'row-for-ada')))
      expect(sealed).not.toContain('row-for-ada')
    } finally {
      await rt.dispose()
    }
  })

  test('a secret sealed before owners is opened, and said to be tied to nothing', async () => {
    const { cipher, rt } = await vault()

    try {
      const old = await cipher.encrypt(JSON.stringify({ token: 'from before' }))

      expect(await rt.runPromise(Vault.use((v) => v.open(old, 'any row', Token)))).toEqual({
        value: { token: 'from before' },
        bound: false,
      })
    } finally {
      await rt.dispose()
    }
  })

  test('a secret that is not the shape expected is refused', async () => {
    const { rt } = await vault()

    try {
      const sealed = await rt.runPromise(Vault.use((v) => v.seal({ other: 1 }, 'row')))

      await expect(rt.runPromise(Vault.use((v) => v.open(sealed, 'row', Token)))).rejects.toThrow(
        'not what was expected',
      )
    } finally {
      await rt.dispose()
    }
  })
})
