import { describe, expect, test } from 'bun:test'

import {
  type CrmField,
  fieldInputSchema,
  fieldSchema,
  fieldTypes,
  isTextLike,
} from '../../src/crm/field-types'

const field = (f: Record<string, unknown>) => fieldSchema.parse(f)

const parse = (f: Record<string, unknown>, value: unknown) =>
  fieldInputSchema(field(f)).safeParse(value)

describe('field types', () => {
  test('every type has a column and an input parser', () => {
    for (const [type, def] of Object.entries(fieldTypes)) {
      expect(def.column.length, type).toBeGreaterThan(0)
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
