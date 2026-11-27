import { describe, expect, test } from 'bun:test'

import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

import { crmConfigSchema } from '../../src/crm/config-schema'
import { InlineField } from '../../src/crm/ui/inline-field'
import { CheckCircle } from '../../src/crm/ui/kit'
import { TaskRow } from '../../src/crm/ui/workspace'
import { pageReach, WriteReachContext } from '../../src/crm/ui/write-reach'
import scoped from '../fixtures/scoped.config.json' with { type: 'json' }

// What a page draws for someone who can't change what it shows: the value, and
// nothing that would change it. Drawn once on the server, as the first page
// is; what a click does is the browser tests' to say (apps/starter/e2e).

const config = crmConfigSchema.parse(scoped)

/**
 * Drawn once, outside a router: these components only reach for the router
 * when something is clicked, and its warning that there is none is not what
 * is being tested.
 */
const drawn = (node: ReactNode): string => {
  const warn = console.warn
  console.warn = () => undefined

  try {
    return renderToString(node)
  } finally {
    console.warn = warn
  }
}

/** Drawn as someone who writes these scopes would see it. No session at all is a Spool without scopes. */
const drawnFor = (writes: 'all' | string[] | null, node: ReactNode) =>
  drawn(
    createElement(
      WriteReachContext,
      {
        value: pageReach(
          writes === null ? null : { canWrite: writes === 'all' || writes.length > 0, writes },
          config,
        ),
      },
      node,
    ),
  )

const status = config.objects['contacts']?.fields['status']

if (!status) {
  throw new Error('The scoped config has no contacts.status')
}

const field = (branch: string, readOnly?: boolean) =>
  createElement(InlineField, {
    objectKey: 'contacts',
    record: { id: 'c1', name: 'Nina Alder', status: 'lead', branch },
    fieldKey: 'status',
    field: status,
    titleFieldOf: () => 'name',
    readOnly,
  })

const task = (scope: string | null) =>
  createElement(TaskRow, {
    showRecord: false,
    task: {
      id: 't1',
      title: 'Ring Alder',
      dueDate: null,
      completedAt: null,
      assigneeId: null,
      objectKey: null,
      recordId: null,
      recordTitle: null,
      scope,
    },
  })

describe('a field on a record', () => {
  test('is edited in place by whoever can change the record', () => {
    for (const html of [
      drawnFor(null, field('south')),
      drawnFor('all', field('south')),
      drawnFor(['north'], field('north')),
    ]) {
      expect(html).toContain('role="button"')
      expect(html).not.toContain('data-read-only')
    }
  })

  test('is only shown to whoever can’t: a read-only person, or a record of a scope they only read', () => {
    for (const html of [
      drawnFor([], field('north')),
      drawnFor(['north'], field('south')),
      // Whatever the person may change, a page can ask for the value alone.
      drawnFor('all', field('north', true)),
    ]) {
      expect(html).toContain('data-read-only')
      expect(html).toContain('lead')
      expect(html).not.toContain('role="button"')
      expect(html).not.toContain('<input')
    }
  })
})

describe('a task', () => {
  test('is ticked off and deleted by whoever writes its scope', () => {
    for (const html of [
      drawnFor(null, task('south')),
      drawnFor(['north'], task('north')),
      // On a shared object's record, or on none: anyone's who writes anything.
      drawnFor(['north'], task('*')),
      drawnFor(['north'], task(null)),
    ]) {
      expect(html).toContain('aria-label="Mark as done"')
      expect(html).toContain('aria-label="Delete task"')
      expect(html).not.toContain('disabled=""')
    }
  })

  test('is shown, and nothing more, to whoever only reads it', () => {
    for (const html of [drawnFor([], task('north')), drawnFor(['north'], task('south'))]) {
      expect(html).toContain('Ring Alder')
      expect(html).toContain('aria-label="Not done"')
      expect(html).toMatch(/role="checkbox"[^>]* disabled=""/)
      expect(html).not.toContain('Delete task')
    }
  })
})

test('a check that can’t be changed says what it is, and takes no click', () => {
  const html = renderToString(
    createElement(CheckCircle, {
      checked: true,
      onChange: () => undefined,
      label: 'Done',
      disabled: true,
    }),
  )

  expect(html).toMatch(/aria-checked="true"[^>]* disabled=""/)
})
