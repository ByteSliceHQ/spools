import { expect, test } from 'bun:test'

import { crmConfigSchema } from '@swirls/spools/config-schema'

import starter from '../../../starter/crm.config.json'
import { requests } from './requests'

for (const { label, lang, code } of requests) {
  test(`what an agent writes to "${label}" is valid`, () => {
    if (lang === 'ts') {
      expect(new Bun.Transpiler({ loader: 'ts' }).transformSync(code)).toContain('createTask')
      return
    }

    const added = JSON.parse(`{${code}}`)

    const config = {
      ...starter,
      campaigns: { ...starter.campaigns, ...added.campaigns },
      automations: [...starter.automations, ...(added.automations ?? [])],
      objects: added.renewals ? { ...starter.objects, renewals: added.renewals } : starter.objects,
    }

    expect(crmConfigSchema.safeParse(config).error?.issues ?? []).toEqual([])
  })
}
