import { describe, expect, test } from 'bun:test'

import { toGrants } from '../../src/adapters/auth/clerk/server'
import { crmConfigSchema } from '../../src/crm/config-schema'
import { createMemory } from '../../src/crm/memory'
import {
  accessFrom,
  NO_ACCESS,
  type ScopeAccess,
  type ScopeGrant,
  type ScopeRoles,
  scopeKey,
  SYSTEM_ACCESS,
} from '../../src/crm/scopes'
import { createIndexStore, type QuickIndex, recentsKey } from '../../src/crm/search'
import { wantedScope } from '../../src/server/scopes'
import scoped from '../fixtures/scoped.config.json' with { type: 'json' }

// Record scopes, the parts that need no database: the config's checks, what a
// person may reach from what they hold, and what the browser keeps when the
// scope changes.

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

  test('one scope: its records, and new records go to it', () => {
    expect(accessFrom(roles, [north])).toEqual(only('north'))
    expect(accessFrom(roles, [{ scope: 'north', role: 'viewer' }])).toEqual(only('north', false))
  })

  test('several scopes: one at a time, or all of them with nothing active', () => {
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

  test('a scope that is not held is never taken on the asker’s word', () => {
    expect(accessFrom(roles, [north], 'south')).toEqual(only('north'))
    expect(accessFrom(roles, [], 'north')).toEqual(NO_ACCESS)
    expect(accessFrom(roles, [], null)).toEqual(NO_ACCESS)
    // `*` is a scope key only for a role that reaches every scope.
    expect(accessFrom(roles, [{ scope: '*', role: 'member' }], null)).toEqual(NO_ACCESS)
  })

  test('a role that reaches every scope does, read-write or read-only, and can narrow to one', () => {
    const office: ScopeGrant = { scope: '*', role: 'headOffice' }
    const everything: ScopeAccess = { read: 'all', write: 'all', active: null }
    expect(accessFrom(roles, [office], null)).toEqual(everything)
    expect(accessFrom(roles, [office])).toEqual(everything)
    // A person is never the system, whatever their role.
    expect(accessFrom(roles, [office], null).system).toBeUndefined()
    expect(SYSTEM_ACCESS.system).toBe(true)
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
  })

  test('a role the config does not have gives nothing', () => {
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

  test('comes from its cookie: a scope, all of mine, or nothing said', () => {
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

  test('an index read for one scope is dropped, not merged, when the server answers for another', async () => {
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
  })

  test('picker answers and titles remembered for one scope are forgotten when the session is for another', async () => {
    let scope = 'north'
    let dropped = 0
    const asked: string[] = []

    const memory = createMemory({
      session: async () => ({ scope }),
      search: async (objectKey: string, q: string) => {
        asked.push(`${scope}:${objectKey}:${q}`)
        return scope
      },
      title: async () => scope,
      usable: () => true,
      scopeOf: (session: { scope: string }) => session.scope,
      onScopeChange: () => dropped++,
      remember: true,
      sessionFreshMs: 0,
    })

    await memory.session()
    expect(await memory.search('companies', 'a')).toBe('north')
    expect(await memory.search('companies', 'a')).toBe('north')
    expect(asked).toEqual(['north:companies:a'])
    expect(dropped).toBe(0)

    // The person switched scope in another tab: the next session this tab is given says so.
    scope = 'south'
    memory.keep({ scope })
    expect(dropped).toBe(1)
    expect(await memory.search('companies', 'a')).toBe('south')
    expect(await memory.title('companies', 'id')).toBe('south')
    expect(asked).toEqual(['north:companies:a', 'south:companies:a'])
  })

  test('recently opened records are kept per scope in the browser', () => {
    expect(recentsKey()).toBe('crm-recent')
    expect(recentsKey('north')).toBe('crm-recent:north')
    expect(recentsKey('north+south')).not.toBe(recentsKey('north'))
  })

  test('the index store can be emptied at once, for the moment of a switch', async () => {
    const store = createIndexStore(async () =>
      index('north', 'Nina Alder', '2026-01-01T00:00:00.000Z'),
    )

    await store.refresh()
    expect(store.get()).toBeDefined()
    store.clear()
    expect(store.get()).toBeUndefined()
  })
})

describe('Clerk organizations as record scopes', () => {
  test('a membership is the organization’s slug and the role without Clerk’s prefix', () => {
    expect(
      toGrants([
        { role: 'org:member', organization: { id: 'org_1', slug: 'north', name: 'North' } },
        { role: 'org:admin', organization: { id: 'org_2', slug: null, name: 'Head office' } },
        { role: 'viewer', organization: { id: 'org_3', slug: 'south', name: 'South' } },
      ]),
    ).toEqual([
      { scope: 'north', role: 'member' },
      { scope: 'org_2', role: 'admin' },
      { scope: 'south', role: 'viewer' },
    ])
  })
})
