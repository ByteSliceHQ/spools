import { test } from 'bun:test'

import raw from '../../../../apps/starter/crm.config.json'

/**
 * The integration tests exercise the framework through the starter's objects
 * (companies, contacts, deals). A starter without them would leave nothing
 * tested, so that is a failure here, not a quiet skip.
 */
export const isExampleApp = ['companies', 'contacts', 'deals'].every((key) => key in raw.objects)

if (!isExampleApp) {
  throw new Error(
    "The framework's integration tests need companies, contacts and deals in apps/starter/crm.config.json.",
  )
}

/** A test against the starter's objects. */
export const exampleTest = test
