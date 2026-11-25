import { describe, expect, test } from 'bun:test'

import { Layer } from 'effect'

import {
  type CipherStashClient,
  cipherOver,
  cipherstash,
  cipherStashConfigured,
} from '../../src/adapters/vault/cipherstash/server'
import { httpLayer } from '../../src/server/runtime/http'
import { Vault, VaultError } from '../../src/server/runtime/vault'
import { spool } from '../../src/server/spool'
import { testRuntime, withEnv } from '../../src/testing/run'

// The CipherStash adapter with a stand-in for the CipherStash client: what is
// tested is everything of ours around it. The client itself needs a live workspace.

const where = { table: 'integrations', column: 'credentials' }

/** Hides text the way a reversible stand-in can, and records what it was asked. */
function standIn(change: Partial<CipherStashClient> = {}) {
  const asked: { plaintext?: string; where?: unknown; payload?: unknown }[] = []

  const client: CipherStashClient = {
    async encrypt(plaintext, at) {
      asked.push({ plaintext, where: at })
      return { data: { c: Buffer.from(plaintext).toString('base64'), k: 'key-1' } }
    },
    async decrypt(payload) {
      asked.push({ payload })
      const { c } = JSON.parse(JSON.stringify(payload))
      return { data: Buffer.from(String(c), 'base64').toString() }
    },
    ...change,
  }

  return { client, asked }
}

describe('the CipherStash cipher', () => {
  test("what is stored is the client's encrypted payload, and it opens to what was sealed", async () => {
    const { client, asked } = standIn()
    const cipher = cipherOver(client, where)
    const sealed = await cipher.encrypt('{"accessToken":"ya29.secret"}')

    expect(sealed).not.toContain('ya29')
    expect(JSON.parse(sealed)).toEqual({ c: expect.any(String), k: 'key-1' })
    // Encrypted for the one column tokens are kept in.
    expect(asked[0]?.where).toEqual(where)

    expect(await cipher.decrypt(sealed)).toBe('{"accessToken":"ya29.secret"}')
    expect(asked[1]?.payload).toEqual(JSON.parse(sealed))
  })

  test('a refusal to encrypt or decrypt is said in its own words, and nothing is returned', async () => {
    const refuse = async () => ({
      failure: { type: 'EncryptionError', message: 'workspace not found' },
    })

    const refusing = cipherOver(standIn({ encrypt: refuse, decrypt: refuse }).client, where)

    await expect(refusing.encrypt('secret')).rejects.toThrow(
      'Could not encrypt: workspace not found',
    )

    await expect(refusing.encrypt('secret')).rejects.toBeInstanceOf(VaultError)

    await expect(refusing.decrypt('{"c":"x"}')).rejects.toThrow(
      'Could not decrypt: workspace not found',
    )
  })

  test('something stored that was never an encrypted payload is refused before the client is asked', async () => {
    const { client, asked } = standIn()

    await expect(cipherOver(client, where).decrypt('ya29.plaintext-token')).rejects.toThrow(
      'not an encrypted payload',
    )

    expect(asked).toEqual([])
  })

  test('a decrypted value that is not text is refused', async () => {
    const odd = cipherOver(
      standIn({ decrypt: async () => ({ data: { not: 'text' } }) }).client,
      where,
    )

    await expect(odd.decrypt('{"c":"x"}')).rejects.toThrow('unexpected type')
  })
})

describe('the CipherStash vault', () => {
  const credentials = {
    CS_WORKSPACE_CRN: 'crn:test',
    CS_CLIENT_ID: 'id',
    CS_CLIENT_KEY: 'key',
    CS_CLIENT_ACCESS_KEY: 'access',
  }

  test('is set up only with all four credentials', () => {
    expect(cipherStashConfigured(credentials)).toBe(true)

    for (const name of Object.keys(credentials)) {
      expect(cipherStashConfigured({ ...credentials, [name]: '' })).toBe(false)
    }
  })

  test('without them nothing is sealed, it says what to set, and the SDK is never loaded', async () => {
    const saved = Object.fromEntries(
      Object.keys(credentials).map((name) => [name, process.env[name]]),
    )

    for (const name of Object.keys(credentials)) {
      delete process.env[name]
    }

    const rt = testRuntime(
      cipherstash().layer.pipe(
        Layer.provide(spool().database.layer),
        Layer.provide(httpLayer()),
        Layer.provide(withEnv({})),
      ),
    )

    try {
      expect(await rt.runPromise(Vault.use((v) => v.problem))).toContain('CS_* variables')

      await expect(rt.runPromise(Vault.use((v) => v.seal({ token: 'x' }, 'row')))).rejects.toThrow(
        'Set CS_WORKSPACE_CRN, CS_CLIENT_ID, CS_CLIENT_KEY, CS_CLIENT_ACCESS_KEY',
      )
    } finally {
      await rt.dispose()

      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) {
          process.env[name] = value
        }
      }
    }
  })

  test('says which service it is in the boot report', () => {
    const adapter = cipherstash()
    expect(adapter.id).toBe('cipherstash')
    expect(adapter.features?.[0]?.vars).toEqual(Object.keys(credentials))
  })
})
