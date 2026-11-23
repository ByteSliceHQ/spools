import { describe, expect, test } from 'bun:test'

import { packagesFor, ports, spoolFile, startingSelection, variablesFor } from './adapters'

describe('the picker on the home page', () => {
  for (const port of ports) {
    for (const choice of port.choices) {
      test(`${port.id}: ${choice.label} is something the package exports`, async () => {
        const module = await import(choice.module)

        for (const name of choice.names) {
          expect(module[name]).toBeFunction()
        }
      })
    }
  }

  test('writes the file for what was chosen', () => {
    expect(
      spoolFile({ ...startingSelection, files: null, email: null, vault: null, agents: null }),
    ).toBe(
      `import { defineSpool } from '@swirls/spools'
import { clerk } from '@swirls/spools/auth/clerk'
import { postgres } from '@swirls/spools/database/postgres'
import crm from '../crm.config.json' with { type: 'json' }
import extensions from './app/extensions'

export default defineSpool({
  crm,
  extensions,
  auth: clerk(),
  database: postgres(),
})`,
    )
  })

  test('adds the contract Prisma needs', () => {
    const file = spoolFile({ ...startingSelection, database: 'Prisma' })
    expect(file).toContain("import contract from '../prisma/schema.json' with { type: 'json' }")
    expect(file).toContain('database: prisma({ contract }),')
  })

  test('lists what to install and set', () => {
    const selection = { ...startingSelection, files: 'Local disk', vault: null, agents: null }

    expect(packagesFor(selection)).toEqual([
      '@clerk/tanstack-react-start',
      '@effect/sql-pg',
      'resend',
    ])

    expect(variablesFor(selection)).toEqual([
      'CLERK_PUBLISHABLE_KEY',
      'CLERK_SECRET_KEY',
      'DATABASE_URL',
      'RESEND_API_KEY',
      'EMAIL_FROM',
    ])
  })
})
