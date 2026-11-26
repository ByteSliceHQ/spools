import { expect, test } from 'bun:test'

import { devAuth } from '../../src/adapters/auth/dev/server'
import * as api from '../../src/server/extension-api'
import { apiRoute } from '../../src/server/handlers'
import { Email } from '../../src/server/runtime/email'
import { installStandIns } from '../../src/testing/run'
import { branches, drive, requestFrom, scopedWorld } from './scopes-world'

// Record scopes from sign-in to records, with nothing stood in for the parts
// that decide: the development sign-in says who is asking and what they hold
// (`devAuth({ scopes })`), the boundary gives the request its scope, the cookie
// switches it, and the store keeps to it.

scopedWorld({
  auth: devAuth({
    scopes: {
      list: branches,
      // Whoever the development sign-in signs in holds both branches.
      grants: {
        'dev@example.com': [
          { scope: 'north', role: 'member' },
          { scope: 'south', role: 'member' },
        ],
      },
    },
  }),
  // The sign-in's own directory and scopes: neither is replaced.
  afterSeed: () =>
    installStandIns({
      email: Email.layerTest(async () => ({ id: 'sent', sent: true })),
      fetch: (url, init) => drive.handle(url, init),
    }),
})

/** An endpoint of the app's own: the contacts its code can list for whoever is signed in. */
const route = apiRoute('test.contacts', async ({ user }) => {
  const contacts = await api.listRecords({ objectKey: 'contacts', limit: 500, relations: 'none' })
  return Response.json({
    user: user.email,
    contacts: contacts.map((c) => String(c.name)).toSorted(),
  })
})

const seenWith = async (scopeCookie?: string) => {
  const request = requestFrom(null, '/api/test/contacts', scopeCookie)
  const response = await route({ request, params: {} })
  expect(response.status).toBe(200)
  return response.json()
}

test('signed in through devAuth({ scopes }), a person sees one scope, switches, and sees the other', async () => {
  // Nothing said: the first branch they hold.
  expect(await seenWith()).toEqual({
    user: 'dev@example.com',
    contacts: ['Nell Crossing', 'Nina Alder'],
  })

  // The switcher sets the cookie.
  expect((await seenWith('south')).contacts).toEqual(['Sofia Birch'])
  expect((await seenWith('north')).contacts).toEqual(['Nell Crossing', 'Nina Alder'])
  // All of theirs.
  expect((await seenWith('*')).contacts).toHaveLength(3)
  // A branch that isn't one of theirs, or isn't one at all, changes nothing.
  expect((await seenWith('west')).contacts).toEqual(['Nell Crossing', 'Nina Alder'])
})

test('devAuth without a grant for the person signed in shows them no scoped record', async () => {
  const saved = process.env['DEV_AUTH_EMAIL']
  process.env['DEV_AUTH_EMAIL'] = 'newcomer@example.com'

  try {
    // Who they are is kept for a minute; what they hold is read from the sign-in each time.
    expect((await seenWith('north')).contacts).toEqual([])
    expect((await seenWith('*')).contacts).toEqual([])
  } finally {
    if (saved === undefined) {
      delete process.env['DEV_AUTH_EMAIL']
    } else {
      process.env['DEV_AUTH_EMAIL'] = saved
    }
  }
})
