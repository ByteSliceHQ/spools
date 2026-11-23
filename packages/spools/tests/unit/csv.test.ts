import { expect, test } from 'bun:test'

import { toPublicConfig } from '../../src/crm/config'
import { crmConfigSchema } from '../../src/crm/config-schema'
import { mapCsv, parseCsv, relationCells, titleKey } from '../../src/crm/csv'
import raw from '../fixtures/example.config.json'

const contacts = toPublicConfig(crmConfigSchema.parse(raw)).objects['contacts']!
const relations = { companies: [{ id: 'co-1', title: 'Initech' }] }

test('parseCsv handles quotes, escaped quotes, embedded newlines and CRLF', () => {
  const text = 'Name,Notes\r\n"Lovelace, Ada","said ""hi""\nthen left"\r\n\r\nAlan,\n'

  expect(parseCsv(text)).toEqual([
    ['Name', 'Notes'],
    ['Lovelace, Ada', 'said "hi"\nthen left'],
    ['Alan', ''],
  ])
})

test('mapCsv matches columns by key or label and reports what it ignored', () => {
  const out = mapCsv(contacts, relations, [
    ['Name', 'E-mail', 'Favourite colour', 'status'],
    ['Ada', 'ada@example.com', 'green', 'Qualified'],
  ])

  expect(out.matched).toEqual(['Name', 'Email', 'Status'])
  expect(out.ignored).toEqual(['Favourite colour'])
  expect(out.rows).toEqual([{ name: 'Ada', email: 'ada@example.com', status: 'qualified' }])
})

test('mapCsv turns relation titles into ids and drops unknown relations and blank rows', () => {
  const out = mapCsv(contacts, relations, [
    ['name', 'company'],
    ['Ada', 'initech'],
    ['Alan', 'Nowhere Ltd'],
    ['', ''],
  ])

  expect(out.rows).toEqual([{ name: 'Ada', companyId: 'co-1' }, { name: 'Alan' }])
})

test('relationCells lists what the relation columns say, once each, per related object', () => {
  const table = [
    ['Name', 'Company', 'Status'],
    ['Ada', ' Initech ', 'lead'],
    ['Alan', 'Initech', 'lead'],
    ['Grace', '', 'lead'],
    ['Edsger', 'Globex Corp.'],
  ]

  expect(relationCells(contacts, table)).toEqual({ companies: ['Initech', 'Globex Corp.'] })

  expect(
    relationCells(contacts, [
      ['name', 'email'],
      ['Ada', 'ada@example.com'],
    ]),
  ).toEqual({})

  expect(relationCells(contacts, [])).toEqual({})
})

test('a relation cell matches a title whatever its case, spacing or punctuation', () => {
  expect(titleKey('Globex Corp.')).toBe(titleKey('  globex   CORP'))
  expect(titleKey('Globex')).not.toBe(titleKey('Globex Corp'))
})
