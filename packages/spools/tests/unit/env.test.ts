import { expect, test } from 'bun:test'

import { databaseUrl } from '../../src/adapters/database/postgres/server'

const pooled =
  'postgres://postgres.ref:pw@pooler.example:6543/postgres?sslmode=require&supa=base-pooler.x'

test('DATABASE_URL wins and is used as written', () => {
  const url = 'postgresql://app:pw@db.example:5432/app?sslmode=require'
  expect(databaseUrl({ DATABASE_URL: url, POSTGRES_URL: pooled })).toBe(url)
})

test("falls back to the POSTGRES_URL that Supabase's integration sets", () => {
  const url = new URL(databaseUrl({ POSTGRES_URL: pooled }) ?? '')
  expect(url.username).toBe('postgres.ref')
  expect(url.port).toBe('6543')
  // node-postgres rejects the pooler's certificate chain under `require`.
  expect(url.searchParams.get('sslmode')).toBe('no-verify')
})

test('is undefined when neither variable is set', () => {
  expect(databaseUrl({})).toBeUndefined()
})
