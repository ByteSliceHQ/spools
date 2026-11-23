import { expect, test } from 'bun:test'

import { crmConfigSchema } from '@swirls/spools/config-schema'

import crm from '../crm.config.json' with { type: 'json' }
import extensions from '../src/app/extensions'

test('crm.config.json is valid', () => {
  expect(crmConfigSchema.safeParse(crm).error?.issues ?? []).toEqual([])
})

test('every local: target in the config has a handler', () => {
  const targets = [
    ...Object.values(crm.objects).flatMap((object) => ('actions' in object ? object.actions : [])),
    ...crm.automations,
  ].map(({ run }) => run)

  const handlers = Object.keys(extensions.handlers ?? {})

  for (const target of targets.filter((run) => run.startsWith('local:'))) {
    expect(handlers).toContain(target.replace('local:', ''))
  }
})

test("a new contact's email is kept in lower case", async () => {
  expect(
    await extensions.hooks?.beforeCreate?.({
      objectKey: 'contacts',
      values: { name: 'Ada', email: 'Ada@Example.com' },
      actor: null,
    }),
  ).toEqual({ name: 'Ada', email: 'ada@example.com' })
})
