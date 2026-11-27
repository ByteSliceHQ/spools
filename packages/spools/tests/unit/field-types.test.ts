import { describe, expect, test } from 'bun:test'

import {
  type CrmField,
  fieldInputSchema,
  fieldSchema,
  fieldTypes,
  isTextLike,
} from '../../src/crm/field-types'
import { LINKS_EXPORT, LINKS_WRITE } from '../../src/crm/links'

const field = (f: Record<string, unknown>) => fieldSchema.parse(f)

const parse = (f: Record<string, unknown>, value: unknown) =>
  fieldInputSchema(field(f)).safeParse(value)

describe('field types', () => {
  test('every type has a column, or none when its values are rows of a links table, and an input parser', () => {
    for (const [type, def] of Object.entries(fieldTypes)) {
      if (type === 'relations') {
        expect(def.column, type).toBeNull()
      } else {
        expect(def.column?.length ?? 0, type).toBeGreaterThan(0)
      }

      expect(typeof def.input, type).toBe('function')
    }
  })

  test('blank input becomes null unless the field is required', () => {
    expect(parse({ type: 'text' }, '').data).toBeNull()
    expect(parse({ type: 'text', required: true }, '').success).toBe(false)
    expect(parse({ type: 'boolean', required: true }, undefined).data).toBe(false)
  })

  test('coerces form strings', () => {
    expect(parse({ type: 'number' }, '42').data).toBe(42)
    expect(parse({ type: 'currency' }, '1234.5').data).toBe('1234.50')
    expect(parse({ type: 'boolean' }, 'on').data).toBe(true)
    expect(parse({ type: 'datetime' }, '2026-11-11T10:00').data).toBeInstanceOf(Date)
  })

  test('rejects invalid values', () => {
    expect(parse({ type: 'email' }, 'nope').success).toBe(false)
    expect(parse({ type: 'date' }, '11/11/2026').success).toBe(false)
    expect(parse({ type: 'relation', to: 'companies' }, 'not-a-uuid').success).toBe(false)
    expect(parse({ type: 'select', options: [{ value: 'a' }] }, 'b').success).toBe(false)
  })

  test('a relations field takes a set of ids, the ids in one string, or what to add and remove', () => {
    const a = '11111111-1111-4111-8111-111111111111'
    const b = '22222222-2222-4222-8222-222222222222'
    const tags = { type: 'relations', to: 'tags' }

    expect(parse(tags, [a, b, a]).data).toEqual({ set: [a, b] })
    expect(parse(tags, `${a}, ${b}`).data).toEqual({ set: [a, b] })
    expect(parse(tags, '').data).toEqual({ set: [] })
    expect(parse(tags, null).data).toEqual({ set: [] })
    expect(parse(tags, { add: [a] }).data).toEqual({ add: [a], remove: [] })
    expect(parse(tags, { remove: [a, a] }).data).toEqual({ add: [], remove: [a] })
    expect(parse(tags, ['nope']).success).toBe(false)
    expect(parse(tags, { add: [a], set: [b] }).success).toBe(false)

    // As many as an export writes in one cell, and no more. What is wrong is said about what was sent.
    const ids = (n: number) => Array.from({ length: n }, () => a)
    const said = (value: unknown) => parse(tags, value).error?.issues.map((i) => i.message)

    expect(LINKS_WRITE).toBeGreaterThanOrEqual(LINKS_EXPORT)
    expect(parse(tags, ids(LINKS_EXPORT)).data).toEqual({ set: [a] })

    expect(said(ids(LINKS_WRITE + 1))).toEqual([
      'this names 1,001 records, and one write takes at most 1,000. Send the rest in further writes, as { "add": [...] }',
    ])

    expect(said({ remove: ids(LINKS_WRITE + 1) })?.[0]).toStartWith('"remove" names 1,001 records')
    expect(said({ set: ['nope'] })?.join()).not.toContain('Unrecognized key')
    expect(said({ add: [a], set: [b] })?.join()).toContain('Unrecognized key')
  })

  test('url fields only accept http(s)', () => {
    expect(parse({ type: 'url' }, 'https://example.com').success).toBe(true)
    expect(parse({ type: 'url' }, 'javascript:alert(1)').success).toBe(false)
  })

  test('text-like types are the ones that can be searched and encrypted', () => {
    expect(
      ['text', 'longtext', 'email', 'phone', 'url'].every((t) => isTextLike(t as CrmField['type'])),
    ).toBe(true)

    expect(isTextLike('number')).toBe(false)
    expect(isTextLike('relation')).toBe(false)
  })
})
