import { describe, expect, test } from 'bun:test'

import { crmConfigSchema } from '../../src/crm/config-schema'
import {
  accessFrom,
  NO_ACCESS,
  type ScopeAccess,
  type ScopeGrant,
  type ScopeRoles,
  scopeKey,
  SYSTEM_ACCESS,
} from '../../src/crm/scopes'
import { createIndexStore, type QuickIndex } from '../../src/crm/search'
import { wantedScope } from '../../src/server/scopes'
import scoped from '../fixtures/scoped.config.json' with { type: 'json' }

// Record scopes, the parts that need no database: the config's checks, what a
// person may reach from what they hold, and what the browser keeps when the
// scope changes. `pending` tests fail until the feature is written
// (SCOPES_STRICT=1 runs them as plain tests, to read why).

const pending = process.env['SCOPES_STRICT'] === '1' ? test : test.failing

describe('scopes in crm.config.json', () => {
  const problems = (scopes: unknown) => {
    const result = crmConfigSchema.safeParse({ ...scoped, scopes })
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  }

  test('a config without scopes has none, and one with them names objects, fields and roles', () => {
    const { scopes: _scopes, ...unscoped } = scoped
    expect(crmConfigSchema.parse(unscoped).scopes).toBeUndefined()

    expect(crmConfigSchema.parse(scoped).scopes).toEqual({
      label: 'Branch',
      labelPlural: 'Branches',
      objects: { companies: 'branch', contacts: 'branch', deals: 'branch' },
      roles: {
        member: { write: true, all: false },
        viewer: { write: false, all: false },
        headOffice: { write: true, all: true },
      },
    })
  })

  test('the scope field must be a select, text or relation field of an object the config has', () => {
    const roles = scoped.scopes.roles
    expect(problems({ objects: { contacts: 'branch' }, roles })).toEqual([])
    expect(problems({ objects: { contacts: 'company' }, roles })).toEqual([])

    expect(problems({ objects: { suppliers: 'branch' }, roles })).toEqual([
      'scopes.objects.suppliers: unknown object "suppliers"',
    ])

    for (const field of ['region', 'owner', 'email']) {
      expect(problems({ objects: { contacts: field }, roles })).toEqual([
        `scopes.objects.contacts: "${field}" must be a select, text or relation field on contacts, and not encrypted`,
      ])
    }

    expect(problems({ objects: {}, roles })).toEqual([
      'scopes.objects: name at least one object and the field that holds its scope',
    ])

    expect(problems({ objects: { contacts: 'branch' }, roles: {} })).toEqual([
      'scopes.roles: name at least one role, e.g. { "member": { "write": true } }',
    ])
  })
})

describe('what a person may reach', () => {
  const roles: ScopeRoles = {
    member: { write: true, all: false },
    viewer: { write: false, all: false },
    headOffice: { write: true, all: true },
    auditor: { write: false, all: true },
  }

  const north: ScopeGrant = { scope: 'north', role: 'member' }
  const south: ScopeGrant = { scope: 'south', role: 'member' }

  const only = (scope: string, write = true): ScopeAccess => ({
    read: [scope],
    write: write ? [scope] : [],
    active: scope,
  })

  pending('one scope: its records, and new records go to it', () => {
    expect(accessFrom(roles, [north])).toEqual(only('north'))
    expect(accessFrom(roles, [{ scope: 'north', role: 'viewer' }])).toEqual(only('north', false))
  })

  pending('several scopes: one at a time, or all of them with nothing active', () => {
    expect(accessFrom(roles, [north, south])).toEqual(only('north'))
    expect(accessFrom(roles, [north, south], 'south')).toEqual(only('south'))

    expect(accessFrom(roles, [north, south], null)).toEqual({
      read: ['north', 'south'],
      write: ['north', 'south'],
      active: null,
    })

    // Read-only in one of them.
    expect(accessFrom(roles, [{ scope: 'north', role: 'viewer' }, south], null)).toEqual({
      read: ['north', 'south'],
      write: ['south'],
      active: null,
    })
  })

  pending('a scope that is not held is never taken on the asker’s word', () => {
    expect(accessFrom(roles, [north], 'south')).toEqual(only('north'))
    expect(accessFrom(roles, [], 'north')).toEqual(NO_ACCESS)
    expect(accessFrom(roles, [], null)).toEqual(NO_ACCESS)
    // `*` is a scope key only for a role that reaches every scope.
    expect(accessFrom(roles, [{ scope: '*', role: 'member' }], null)).toEqual(NO_ACCESS)
  })

  pending(
    'a role that reaches every scope does, read-write or read-only, and can narrow to one',
    () => {
      const office: ScopeGrant = { scope: '*', role: 'headOffice' }
      expect(accessFrom(roles, [office], null)).toEqual(SYSTEM_ACCESS)
      expect(accessFrom(roles, [office], 'south')).toEqual(only('south'))

      // Granted in one scope, it still reaches all of them.
      expect(accessFrom(roles, [{ scope: 'north', role: 'headOffice' }], 'south')).toEqual(
        only('south'),
      )

      expect(accessFrom(roles, [{ scope: '*', role: 'auditor' }], null)).toEqual({
        read: 'all',
        write: [],
        active: null,
      })
    },
  )

  pending('a role the config does not have gives nothing', () => {
    expect(accessFrom(roles, [{ scope: 'north', role: 'owner' }])).toEqual(NO_ACCESS)
    expect(accessFrom(roles, [{ scope: 'north', role: 'constructor' }])).toEqual(NO_ACCESS)
  })

  test('an access has a short name for what it can read', () => {
    expect(scopeKey(only('north'))).toBe('north')
    expect(scopeKey({ read: ['south', 'north'], write: [], active: null })).toBe('north+south')
    expect(scopeKey(SYSTEM_ACCESS)).toBe('*')
    expect(scopeKey(NO_ACCESS)).toBe('')
  })
})

describe('the scope a request asks to work in', () => {
  const cookie = (value: string) => new Headers({ cookie: value })

  pending('comes from its cookie: a scope, all of mine, or nothing said', () => {
    expect(wantedScope(cookie('theme=dark; spools-scope=south'))).toBe('south')
    expect(wantedScope(cookie('spools-scope=*'))).toBeNull()
    expect(wantedScope(cookie('spools-scope=north%2Bwest'))).toBe('north+west')
  })

  test('says nothing when the request does not', () => {
    expect(wantedScope(new Headers())).toBeUndefined()
    expect(wantedScope(cookie('theme=dark'))).toBeUndefined()
  })
})

describe('what the browser keeps when the scope changes', () => {
  const index = (scope: string, title: string, at: string): QuickIndex => ({
    at,
    scope,
    objects: { contacts: { fields: [], rows: [[`${scope}-1`, title, '']], total: 1 } },
    notes: { rows: [[`${scope}-note`, `${title} pricing`, 'contacts', `${scope}-1`]], total: 1 },
    views: [],
  })

  pending(
    'an index read for one scope is dropped, not merged, when the server answers for another',
    async () => {
      let scope = 'north'
      const asked: (string | undefined)[] = []

      const store = createIndexStore(
        async (since) => {
          asked.push(since)
          // Asked what changed since: nothing did. The counts add up, so today the old rows are kept.
          return since === undefined
            ? index(
                scope,
                scope === 'north' ? 'Nina Alder' : 'Sofia Birch',
                '2026-01-01T00:00:00.000Z',
              )
            : {
                ...index(scope, '', since),
                objects: { contacts: { fields: [], rows: [], total: 1 } },
                notes: { rows: [], total: 1 },
              }
        },
        { freshMs: 0 },
      )

      expect(JSON.stringify(await store.refresh())).toContain('Nina Alder')

      // The person switches to South. The next answer is South's.
      scope = 'south'
      const after = await store.refresh()
      expect(JSON.stringify(after)).not.toContain('Alder')
      expect(JSON.stringify(after)).toContain('Sofia Birch')
      expect(after.scope).toBe('south')
      // It was fetched whole, not as changes to the North index.
      expect(asked.at(-1)).toBeUndefined()
    },
  )

  test.todo(
    'relation titles and picker answers remembered for one scope are forgotten on a switch (src/crm/memory.ts)',
  )

  test.todo('recently opened records are kept per scope in this browser (src/crm/ui/search.tsx)')

  test.todo(
    'the scope switcher in the shell invalidates the router and the session (src/crm/ui/shell.tsx, e2e)',
  )
})

describe('the guard’s rewrite of a condition (src/server/store/scope.ts)', () => {
  test.todo('a scoped table’s condition gains "scope is one of those read"')
  test.todo('`some` and `none` are narrowed on the table they reach, at any depth')
  test.todo('a table reached only through relations (a join table) is scoped by both sides')
  test.todo('an unscoped table’s condition is returned as it was given')
})
