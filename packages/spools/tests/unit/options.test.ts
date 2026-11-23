import { describe, expect, test } from 'bun:test'

import {
  allowedOptions,
  controllingFields,
  hasProbabilities,
  reconcileDependents,
  touchesDependents,
  weighted,
} from '../../src/crm/options'

const fields = {
  title: { type: 'text' },
  pipeline: {
    type: 'select',
    default: 'sales',
    options: [
      { value: 'sales', label: 'Sales' },
      { value: 'bids', label: 'Bids' },
    ],
  },
  stage: {
    type: 'select',
    label: 'Stage',
    dependsOn: 'pipeline',
    default: 'visit',
    options: [
      { value: 'visit', label: 'Visit', when: ['sales'], probability: 30 },
      { value: 'proposal', label: 'Proposal', when: ['sales'], probability: 40 },
      { value: 'bidOut', label: 'Bid out', when: ['bids'], probability: 50 },
      { value: 'won', label: 'Won', probability: 100 },
      { value: 'lost', label: 'Lost', probability: 0 },
    ],
  },
}

const values = (field: { value: string }[]) => field.map((o) => o.value)

describe('dependent options', () => {
  test('only the options that apply to the controlling value are offered', () => {
    expect(values(allowedOptions(fields.stage, 'sales'))).toEqual([
      'visit',
      'proposal',
      'won',
      'lost',
    ])

    expect(values(allowedOptions(fields.stage, 'bids'))).toEqual(['bidOut', 'won', 'lost'])
    expect(values(allowedOptions(fields.stage, null))).toEqual(['won', 'lost'])
  })

  test('a field without dependsOn offers everything', () => {
    expect(allowedOptions(fields.pipeline, 'anything')).toHaveLength(2)
  })

  test('finds controlling fields and changes that touch a dependency', () => {
    expect([...controllingFields(fields)]).toEqual(['pipeline'])
    expect(touchesDependents(fields, ['title'])).toBe(false)
    expect(touchesDependents(fields, ['pipeline'])).toBe(true)
    expect(touchesDependents(fields, ['stage'])).toBe(true)
  })
})

describe('reconcileDependents', () => {
  test('create: an empty dependent takes its default when that applies', () => {
    const r = reconcileDependents(fields, { title: 'A', pipeline: 'sales', stage: null })
    expect(r).toEqual({ values: { title: 'A', pipeline: 'sales', stage: 'visit' }, issues: [] })
  })

  test("create: falls back to the first option that applies when the default doesn't", () => {
    const r = reconcileDependents(fields, { title: 'A', pipeline: 'bids', stage: null })
    expect(r.values.stage).toBe('bidOut')
    expect(r.issues).toEqual([])
  })

  test('create: a dependent with no default and not required stays empty', () => {
    const optional = { ...fields, stage: { ...fields.stage, default: undefined } }
    expect(reconcileDependents(optional, { pipeline: 'bids', stage: null }).values.stage).toBeNull()
  })

  test('rejects an option from another pipeline, naming both in the message', () => {
    const r = reconcileDependents(fields, { pipeline: 'bids', stage: 'proposal' })

    expect(r.issues).toEqual([
      { field: 'stage', message: '"Proposal" is not a Stage option when pipeline is "Bids"' },
    ])
  })

  test('update: validates against the stored controlling value', () => {
    const stored = { pipeline: 'sales', stage: 'visit' }
    expect(reconcileDependents(fields, { stage: 'proposal' }, stored).issues).toEqual([])
    expect(reconcileDependents(fields, { stage: 'bidOut' }, stored).issues).toHaveLength(1)
  })

  test('update: changing the controlling field moves a stranded dependent to the first option that applies', () => {
    const r = reconcileDependents(
      fields,
      { pipeline: 'bids' },
      { pipeline: 'sales', stage: 'proposal' },
    )

    expect(r).toEqual({ values: { pipeline: 'bids', stage: 'bidOut' }, issues: [] })
  })

  test('update: a dependent that still applies is left alone', () => {
    const r = reconcileDependents(fields, { pipeline: 'bids' }, { pipeline: 'sales', stage: 'won' })
    expect(r.values).toEqual({ pipeline: 'bids' })
  })

  test('update: clearing the dependent on purpose is respected', () => {
    const r = reconcileDependents(
      fields,
      { pipeline: 'bids', stage: null },
      { pipeline: 'sales', stage: 'visit' },
    )

    expect(r.values).toEqual({ pipeline: 'bids', stage: null })
  })

  test('a scoped option needs the controlling field to be set', () => {
    const r = reconcileDependents(fields, { stage: 'visit' }, { pipeline: null, stage: null })
    expect(r.issues[0]?.message).toBe('"Visit" needs pipeline to be set first')
  })

  test('fields without dependencies pass through untouched', () => {
    const plain = { title: fields.title, pipeline: fields.pipeline }

    expect(reconcileDependents(plain, { title: 'A', pipeline: 'bids' })).toEqual({
      values: { title: 'A', pipeline: 'bids' },
      issues: [],
    })
  })
})

describe('win probability', () => {
  test("weights an amount by the option's probability", () => {
    expect(weighted(2000, { probability: 40 })).toBe(800)
    expect(weighted(2000, { probability: 0 })).toBe(0)
    expect(weighted(2000, {})).toBe(2000)
    expect(weighted(2000, undefined)).toBe(2000)
  })

  test('knows whether a field carries probabilities', () => {
    expect(hasProbabilities(fields.stage)).toBe(true)
    expect(hasProbabilities(fields.pipeline)).toBe(false)
    expect(hasProbabilities(undefined)).toBe(false)
  })
})
