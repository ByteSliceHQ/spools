import { describe, expect, test } from 'bun:test'

import raw from '../../../../apps/starter/crm.config.json'
import { generatePrisma } from '../../src/crm/codegen'
import { crmConfigSchema } from '../../src/crm/config-schema'
import { fieldLabel, modelName } from '../../src/crm/naming'
import example from '../fixtures/example.config.json'

const base = {
  version: 1,
  app: { name: 'Test' },
  access: { allowedDomains: ['example.com'] },
  objects: {
    companies: {
      label: 'Company',
      labelPlural: 'Companies',
      titleField: 'name',
      fields: { name: { type: 'text', required: true } },
      views: [{ id: 'all', label: 'All', type: 'table', columns: ['name'] }],
    },
  },
}

const issues = (cfg: unknown) => {
  const r = crmConfigSchema.safeParse(cfg)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}

describe('config schema', () => {
  test('crm.config.json is valid', () => {
    expect(issues(raw)).toEqual([])
  })

  test('access is deny-by-default', () => {
    expect(issues({ ...base, access: {} }).join()).toContain('deny-by-default')
  })

  test('rejects relations to unknown objects', () => {
    const cfg = structuredClone(base) as any
    cfg.objects.companies.fields.parent = { type: 'relation', to: 'nope' }
    expect(issues(cfg).join()).toContain('unknown object "nope"')
  })

  test('rejects unknown view columns and non-select board grouping', () => {
    const cfg = structuredClone(base) as any
    cfg.objects.companies.views.push({ id: 'b', label: 'B', type: 'board', groupBy: 'name' })
    cfg.objects.companies.views[0].columns.push('missing')
    const msgs = issues(cfg).join()
    expect(msgs).toContain('unknown field "missing"')
    expect(msgs).toContain('board views must group by a select field')
  })

  test('rejects reserved field and object names', () => {
    const cfg = structuredClone(base) as any
    cfg.objects.companies.fields.id = { type: 'text' }
    cfg.objects.assistant = structuredClone(cfg.objects.companies)
    const msgs = issues(cfg).join()
    expect(msgs).toContain('reserved system field')
    expect(msgs).toContain('reserved by a built-in CRM route')
  })

  // The CRM is served from the site root, so an object key is a top-level path.
  test('rejects object names that would shadow a root route', () => {
    for (const key of ['api', 'crm', 'unsubscribe', 'tasks']) {
      const cfg = structuredClone(base) as any
      cfg.objects[key] = structuredClone(cfg.objects.companies)
      expect(issues(cfg).join()).toContain(`"${key}" is reserved by a built-in CRM route`)
    }
  })

  test('encryption only on text-like fields, search needs a searchable mode', () => {
    const cfg = structuredClone(base) as any
    cfg.objects.companies.fields.size = { type: 'number', encrypted: 'eq' }
    cfg.objects.companies.fields.secret = { type: 'text', encrypted: 'storage', searchable: true }
    const msgs = issues(cfg).join()
    expect(msgs).toContain('only text-like fields can be encrypted')
    expect(msgs).toContain('does not support free-text search')
  })

  const withPipelines = () => {
    const cfg = structuredClone(base) as any

    cfg.objects.companies.fields.pipeline = {
      type: 'select',
      options: [{ value: 'sales' }, { value: 'bids' }],
    }

    cfg.objects.companies.fields.stage = {
      type: 'select',
      dependsOn: 'pipeline',
      options: [
        { value: 'visit', when: ['sales'], probability: 30 },
        { value: 'bidOut', when: ['bids'], probability: 50 },
        { value: 'won', probability: 100 },
      ],
    }

    cfg.objects.companies.views.push({
      id: 'sales',
      label: 'Sales',
      type: 'board',
      groupBy: 'stage',
      filters: { pipeline: 'sales' },
    })

    return cfg
  }

  test('accepts dependent options, probabilities and view filters', () => {
    expect(issues(withPipelines())).toEqual([])
  })

  test("dependsOn must name another select that isn't itself dependent", () => {
    const self = withPipelines()
    self.objects.companies.fields.stage.dependsOn = 'stage'
    expect(issues(self).join()).toContain('"stage" must be another select field on companies')

    const text = withPipelines()
    text.objects.companies.fields.stage.dependsOn = 'name'
    expect(issues(text).join()).toContain('"name" must be another select field on companies')

    const chained = withPipelines()
    chained.objects.companies.fields.region = { type: 'select', options: [{ value: 'east' }] }
    chained.objects.companies.fields.pipeline.dependsOn = 'region'
    expect(issues(chained).join()).toContain("can't depend on a dependent field")
  })

  test('when needs dependsOn and values from the controlling field', () => {
    const orphan = withPipelines()
    delete orphan.objects.companies.fields.stage.dependsOn
    expect(issues(orphan).join()).toContain('set "dependsOn" on the field to use "when"')

    const unknown = withPipelines()
    unknown.objects.companies.fields.stage.options[0].when = ['retail']
    expect(issues(unknown).join()).toContain('"retail" is not an option of pipeline')
  })

  test('probability is a percentage and defaults must be options', () => {
    const cfg = withPipelines()
    cfg.objects.companies.fields.stage.options[0].probability = 130
    cfg.objects.companies.fields.pipeline.default = 'retail'
    const msgs = issues(cfg).join()
    expect(msgs).toContain('<=100')
    expect(msgs).toContain('"retail" is not an option')
  })

  test('view filters must use fields, operators and values the config allows', () => {
    const cfg = withPipelines()
    cfg.objects.companies.fields.active = { type: 'boolean' }

    cfg.objects.companies.views[0].filters = {
      name: 'Acme',
      missing: 'x',
      pipeline: 'retail',
      active: 'yes',
    }

    const msgs = issues(cfg).join()

    // A text field has no exact-value shorthand, "missing" is no field, "yes" no boolean.
    for (const name of ['name', 'missing', 'active']) {
      expect(msgs).toContain(`can't filter by "${name}" this way`)
    }

    // The app keeps a filter on an option that has gone (it matches nothing); in the config it is a mistake.
    expect(msgs).toContain('"retail" is not an option of pipeline')

    cfg.objects.companies.views[0].filters = [
      { field: 'pipeline', op: 'notIn', value: ['sales', 'wholesale'] },
    ]

    expect(issues(cfg).join()).toContain('"wholesale" is not an option of pipeline')
  })

  test('view filters accept conditions with operators, in one group or several', () => {
    const cfg = withPipelines()
    cfg.objects.companies.fields.employees = { type: 'number' }

    cfg.objects.companies.views[0].filters = [
      { field: 'name', op: 'contains', value: 'acme' },
      { field: 'employees', op: 'between', value: [10, 50] },
      { field: 'lastContactedAt', op: 'olderThan', value: 30 },
    ]

    expect(issues(cfg)).toEqual([])

    cfg.objects.companies.views[0].filters = [
      [{ field: 'pipeline', op: 'in', value: ['sales'] }],
      [{ field: 'createdAt', op: 'on', value: 'thisMonth' }],
    ]

    expect(issues(cfg)).toEqual([])
    cfg.objects.companies.views[0].filters = [{ field: 'employees', op: 'contains', value: '1' }]
    expect(issues(cfg).join()).toContain(`can't filter by "employees" this way`)
  })

  test('a view sorts by up to three columns, each once; the time zone must be a real one', () => {
    const cfg = withPipelines()

    cfg.objects.companies.views[0].sort = [
      { field: 'name', dir: 'asc' },
      { field: 'createdAt', dir: 'desc' },
    ]

    cfg.app.timezone = 'America/New_York'
    expect(issues(cfg)).toEqual([])
    cfg.objects.companies.views[0].sort = [{ field: 'name' }, { field: 'name', dir: 'desc' }]
    expect(issues(cfg).join()).toContain('sort by each column once')
    cfg.app.timezone = 'Mars/Olympus'
    expect(issues(cfg).join()).toContain('IANA time zone')
  })

  test('the activity dates are reserved field names', () => {
    const cfg = withPipelines()
    cfg.objects.companies.fields.lastContactedAt = { type: 'date' }
    expect(issues(cfg).join()).toContain('"lastContactedAt" is a reserved system field')
  })

  test('requires a known config version', () => {
    expect(issues({ ...base, version: 2 }).length).toBeGreaterThan(0)
    const { version: _v, ...noVersion } = base
    expect(issues(noVersion).length).toBeGreaterThan(0)
  })

  test('run targets must look like <kind>:<name>, and campaigns must exist', () => {
    const cfg = structuredClone(base) as any

    cfg.objects.companies.actions = [
      { id: 'x', label: 'X', run: 'http://evil' },
      { id: 'y', label: 'Y', run: 'campaign:nope' },
      { id: 'z', label: 'Z', run: 'slack:sales' },
    ]

    const msgs = issues(cfg)
    expect(msgs.join()).toContain('<kind>:<name>')
    expect(msgs.join()).toContain('unknown campaign "nope"')
    expect(msgs.length).toBe(2) // custom kinds are checked against extensions, not the schema
  })
})

describe('naming', () => {
  test('model names', () => {
    expect(modelName('companies', {})).toBe('Company')
    expect(modelName('deals', {})).toBe('Deal')
    expect(modelName('people', { model: 'Person' })).toBe('Person')
  })

  test('field labels', () => {
    expect(fieldLabel('closeDate')).toBe('Close Date')
    expect(fieldLabel('x', { label: 'Custom' })).toBe('Custom')
  })
})

// Codegen is tested against a fixed fixture so these tests keep passing when
// crm.config.json is replaced with your own objects.
describe('codegen', () => {
  const cfg = crmConfigSchema.parse(example)
  const { schema, warnings } = generatePrisma(cfg)

  test('emits the Prisma 8 directive and one model per object plus Activity', () => {
    expect(schema.startsWith('// use prisma-8')).toBe(true)

    for (const m of [
      'Company',
      'Contact',
      'Deal',
      'Activity',
      'Task',
      'Note',
      'SavedView',
      'Favorite',
      'Suppression',
    ]) {
      expect(schema).toContain(`model ${m} {`)
    }
  })

  test('maps types, defaults and snake_case columns', () => {
    expect(schema).toContain('value NumericString(14, 2)?\n')
    expect(schema).toContain('closeDate DateString? @map("close_date")')
    expect(schema).toContain('status String? @default("lead")\n')
    expect(schema).toContain('@@map("contacts")')
  })

  test('relations get an FK column, a named relation and a back-relation', () => {
    expect(schema).toContain('companyId String? @map("company_id")')

    expect(schema).toContain(
      '@relation("Contact_company", fields: [companyId], references: [id], onDelete: SetNull)',
    )

    expect(schema).toContain('contactsViaCompany Contact[] @relation("Contact_company")')
  })

  test('required relations restrict deletes', () => {
    const c = structuredClone(cfg)

    ;(c.objects.deals!.fields.company as any).required = true
    expect(generatePrisma(c).schema).toContain('onDelete: Restrict')
  })

  test('warns for every encrypted field while CipherStash is unavailable', () => {
    expect(warnings.length).toBe(3)
    expect(warnings[0]).toContain('PLAINTEXT')
  })
})
