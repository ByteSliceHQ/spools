import { describe, expect, test } from 'bun:test'

import raw from '../../../../apps/starter/crm.config.json'
import { crmConfigSchema } from '../../src/crm/config-schema'
import {
  anchorOf,
  builtInGuides,
  checkGuides,
  fill,
  type Guide,
  type GuideConfig,
  guideToOffer,
  homeOf,
  inPlace,
  isAnchor,
  NO_OFFERS,
  type Place,
  parseWhere,
  placeOf,
  resolveGuides,
  shownSteps,
} from '../../src/crm/guides'
import { guidesOffered } from '../../src/server/guides'
import { runWithEnv } from '../../src/testing/run'

const config: GuideConfig = {
  app: { name: 'Acme' },
  objects: {
    contacts: {
      label: 'Contact',
      labelPlural: 'Contacts',
      fields: { name: { type: 'text' }, email: { type: 'email' } },
      views: [{ id: 'all', type: 'table' }],
    },
    deals: {
      label: 'Deal',
      labelPlural: 'Deals',
      fields: { title: { type: 'text' }, stage: { type: 'select' }, contact: { type: 'relation' } },
      views: [
        { id: 'all', type: 'table' },
        { id: 'pipeline', type: 'board' },
      ],
    },
  },
}

const guides = resolveGuides(config)
const everything = (_anchor: string) => true
const nothing = (_anchor: string) => false

const offer = (place: Place, seen: string[] = [], present = everything, list = guides) =>
  guideToOffer(list, place, new Set(seen), { offers: true, present })?.id ?? null

describe('places', () => {
  test('a page address is a place', () => {
    expect(placeOf('/', config.objects)).toEqual({ page: 'home' })
    expect(placeOf('/tasks', config.objects)).toEqual({ page: 'tasks' })
    expect(placeOf('/deals', config.objects)).toEqual({ page: 'list', object: 'deals' })
    expect(placeOf('/deals/3f0c', config.objects)).toEqual({ page: 'record', object: 'deals' })
    expect(placeOf('/deals/3f0c/more', config.objects)).toEqual({ page: 'other' })
    expect(placeOf('/nowhere', config.objects)).toEqual({ page: 'other' })
    // An object key can't shadow a page, and nothing inherited counts as an object.
    expect(placeOf('/constructor', config.objects)).toEqual({ page: 'other' })
  })

  test('where is read strictly', () => {
    expect(parseWhere('anywhere')).toEqual({ kind: 'anywhere' })
    expect(parseWhere('list')).toEqual({ kind: 'list', object: undefined })
    expect(parseWhere('record:deals')).toEqual({ kind: 'record', object: 'deals' })

    for (const bad of ['', 'lists', 'list:', 'home:deals', 'list:deals:extra', 'anywhere:deals']) {
      expect(parseWhere(bad)).toBeNull()
    }
  })

  test('a guide belongs to its page, its object and nothing else', () => {
    const list: Place = { page: 'list', object: 'deals' }
    expect(inPlace('list', list)).toBe(true)
    expect(inPlace('list:deals', list)).toBe(true)
    expect(inPlace('list:contacts', list)).toBe(false)
    expect(inPlace('record', list)).toBe(false)
    expect(inPlace('anywhere', list)).toBe(true)
    expect(inPlace('anywhere', { page: 'other' })).toBe(true)
    expect(inPlace('tasks', { page: 'tasks' })).toBe(true)
    expect(inPlace('tasks', { page: 'notes' })).toBe(false)
    expect(inPlace('nonsense', list)).toBe(false)
  })

  test('a board guide needs a board on screen', () => {
    expect(inPlace('board', { page: 'list', object: 'deals' })).toBe(false)
    expect(inPlace('board', { page: 'list', object: 'deals', board: true })).toBe(true)
    expect(inPlace('board:contacts', { page: 'list', object: 'deals', board: true })).toBe(false)
  })

  test('while search is open only the search guide belongs', () => {
    const searching: Place = { page: 'list', object: 'deals', search: true }
    expect(inPlace('search', searching)).toBe(true)
    expect(inPlace('list', searching)).toBe(false)
    expect(inPlace('anywhere', searching)).toBe(false)
    expect(inPlace('search', { page: 'list', object: 'deals' })).toBe(false)
  })
})

describe('which guide is offered', () => {
  test('a new person is offered the welcome first, wherever they land', () => {
    expect(offer({ page: 'home' })).toBe('welcome')
    expect(offer({ page: 'list', object: 'deals' })).toBe('welcome')
    expect(offer({ page: 'other' })).toBe('welcome')
  })

  test('after the welcome, each place offers its own guide, one at a time and in order', () => {
    const list: Place = { page: 'list', object: 'deals' }
    expect(offer({ page: 'home' }, ['welcome'])).toBe('home')
    expect(offer(list, ['welcome'])).toBe('list')
    expect(offer(list, ['welcome', 'list'])).toBe('filters')
    expect(offer({ ...list, board: true }, ['welcome', 'list', 'filters'])).toBe('board')
    expect(offer(list, ['welcome', 'list', 'filters'])).toBeNull()
    expect(offer({ page: 'record', object: 'deals' }, ['welcome'])).toBe('record')
    expect(offer({ page: 'record', object: 'deals' }, ['welcome', 'record'])).toBe('recordActions')
    expect(offer({ page: 'list', object: 'deals', search: true }, ['welcome'])).toBe('search')
  })

  test('every page has a guide', () => {
    for (const page of [
      'tasks',
      'notes',
      'files',
      'reports',
      'workflows',
      'integrations',
      'assistant',
    ] as const) {
      expect(offer({ page }, ['welcome'])).toBe(page)
    }
  })

  test('finished and dismissed guides are never offered again', () => {
    const all = guides.map((g) => g.id)

    for (const place of [
      { page: 'home' },
      { page: 'list', object: 'deals', board: true },
      { page: 'record', object: 'contacts' },
      { page: 'tasks' },
      { page: 'list', object: 'deals', search: true },
    ] as Place[]) {
      expect(offer(place, all)).toBeNull()
    }
  })

  test('someone who asked not to be offered guides is offered none, new ones included', () => {
    expect(offer({ page: 'home' }, [NO_OFFERS])).toBeNull()

    const added = [
      ...guides,
      { id: 'later', title: 'Later', where: 'home', steps: [{ title: 't', body: 'b' }] },
    ]

    expect(offer({ page: 'home' }, [NO_OFFERS], everything, added)).toBeNull()
  })

  test('offers can be switched off for everyone', async () => {
    expect(
      guideToOffer(guides, { page: 'home' }, new Set(), { offers: false, present: everything }),
    ).toBeNull()

    expect(await runWithEnv({ CRM_GUIDES: 'off' }, guidesOffered)).toBe(false)
    expect(await runWithEnv({ CRM_GUIDES: 'on' }, guidesOffered)).toBe(true)
    expect(await runWithEnv({}, guidesOffered)).toBe(true)
  })

  test('a guide added later is offered to people who finished the old ones', () => {
    const seenAll = guides.map((g) => g.id)

    const later: Guide = {
      id: 'handOff',
      title: 'Hand-off',
      where: 'record:deals',
      steps: [{ title: 't', body: 'b' }],
    }

    const withNew = [...guides, later]
    expect(offer({ page: 'record', object: 'deals' }, seenAll, everything, withNew)).toBe('handOff')
    // Only in its own place, and only once.
    expect(offer({ page: 'record', object: 'contacts' }, seenAll, everything, withNew)).toBeNull()

    expect(
      offer({ page: 'record', object: 'deals' }, [...seenAll, 'handOff'], everything, withNew),
    ).toBeNull()
  })

  test('a guide with nothing to point at on this page is not offered, and the next one is', () => {
    // A guide whose every step points at something this page lacks is passed over for the next one.
    const emailOnly: Guide = {
      id: 'email',
      title: 'Email',
      where: 'record',
      steps: [{ title: 't', body: 'b', target: 'compose-email' }],
    }

    const noEmail = (anchor: string) => anchor !== 'compose-email'

    expect(
      offer({ page: 'record', object: 'deals' }, ['welcome'], noEmail, [emailOnly, ...guides]),
    ).toBe('record')

    expect(
      offer({ page: 'record', object: 'deals' }, ['welcome'], everything, [emailOnly, ...guides]),
    ).toBe('email')

    // The assistant isn't connected: none of its anchors are there.
    expect(offer({ page: 'assistant' }, ['welcome'], nothing)).toBeNull()
    // The welcome has steps that need no anchor, so it survives an empty page.
    expect(offer({ page: 'home' }, [], nothing)).toBe('welcome')
  })
})

describe('steps', () => {
  const guide: Guide = {
    id: 'g',
    title: 'G',
    where: 'record',
    steps: [
      { title: 'plain', body: 'no target' },
      { title: 'there', body: 'b', target: 'record-details' },
      { title: 'missing', body: 'b', target: 'compose-email' },
      { title: 'kept', body: 'b', target: 'tab:files', keep: true },
      { title: 'either', body: 'b', target: ['record-nav', 'record-back'] },
      { title: 'field', body: 'b', target: 'field:stage' },
    ],
  }

  // An object with no email field, no Files tab and no stage; opened from a link, so no previous/next.
  const onPage = (anchor: string) => ['record-details', 'record-back'].includes(anchor)

  test('a step whose anchor is missing is left out, unless it is kept', () => {
    expect(shownSteps(guide, onPage).map((s) => s.title)).toEqual([
      'plain',
      'there',
      'kept',
      'either',
    ])

    expect(shownSteps(guide, everything)).toHaveLength(6)
    expect(shownSteps(guide, nothing).map((s) => s.title)).toEqual(['plain', 'kept'])
  })

  test('a step points at the first of its anchors that is on the page', () => {
    expect(anchorOf(guide.steps[4]!, onPage)).toBe('record-back')
    expect(anchorOf(guide.steps[4]!, everything)).toBe('record-nav')
    expect(anchorOf(guide.steps[3]!, onPage)).toBeUndefined()
    expect(anchorOf(guide.steps[0]!, everything)).toBeUndefined()
  })

  test('words are filled from the config and the object in view', () => {
    const text = '{Records}: add a {record} to {app}. {Record}s and {records}. {unknown}'

    expect(fill(text, config, { page: 'list', object: 'deals' })).toBe(
      'Deals: add a deal to Acme. Deals and deals. {unknown}',
    )

    expect(fill('a {record}', config, { page: 'home' })).toBe('a record')
    expect(fill('a {record}', config)).toBe('a record')
  })
})

describe('the built-in guides', () => {
  test('none is longer than five steps, and every id is different', () => {
    for (const guide of guides) {
      expect(guide.steps.length).toBeLessThanOrEqual(5)
    }

    expect(new Set(guides.map((g) => g.id)).size).toBe(guides.length)
  })

  test('each names a real place and real anchors', () => {
    for (const guide of builtInGuides(config)) {
      expect(parseWhere(guide.where)).not.toBeNull()

      for (const step of guide.steps) {
        for (const target of [step.target ?? []].flat()) {
          expect(isAnchor(target, config)).toBe(true)
        }
      }
    }
  })

  test('they take their words from the config', () => {
    const welcome = guides.find((g) => g.id === 'welcome')!
    expect(welcome.steps[0]!.body).toContain('Contacts and Deals')
    const none = resolveGuides({ app: { name: 'Empty' }, objects: {} })
    expect(none.find((g) => g.id === 'welcome')!.steps[0]!.body).toContain('its records')
  })

  test('a config with no objects still resolves, and has somewhere to send every guide', () => {
    const empty: GuideConfig = { app: { name: 'Empty' }, objects: {} }

    for (const guide of resolveGuides(empty)) {
      expect(() => homeOf(guide, empty)).not.toThrow()
    }
  })
})

describe("an app's own guides", () => {
  const own: GuideConfig = {
    ...config,
    guides: {
      welcome: { title: 'Welcome to Acme', steps: [{ title: 'Hello', body: 'Our way.' }] },
      workflows: false,
      pipeline: {
        title: 'The pipeline',
        where: 'board:deals',
        steps: [{ title: 'Stages', body: 'One column per stage.', target: 'board' }],
      },
      stage: {
        title: 'Stages',
        where: 'record:deals',
        steps: [{ title: 'Stage', body: 'Where the deal is.', target: 'field:stage' }],
      },
    },
  }

  const resolved = resolveGuides(own)

  test('replace a built-in guide in its place, turn one off, and add new ones', () => {
    const ids = resolved.map((g) => g.id)
    expect(ids[0]).toBe('welcome')
    expect(resolved[0]).toMatchObject({ title: 'Welcome to Acme', where: 'anywhere' })
    expect(resolved[0]!.steps).toHaveLength(1)
    expect(ids).not.toContain('workflows')
    expect(ids).toContain('pipeline')
    expect(ids).toHaveLength(builtInGuides(config).length - 1 + 2)
    expect(checkGuides(own)).toEqual([])
  })

  test('the welcome comes first, then guides for one object, then the rest', () => {
    const ids = resolved.map((g) => g.id)
    expect(ids.slice(0, 4)).toEqual(['welcome', 'pipeline', 'stage', 'home'])

    // The built-in guides keep their own order after them.
    const generic = builtInGuides(config)
      .map((g) => g.id)
      .filter((id) => id !== 'welcome' && id !== 'workflows')

    expect(ids.slice(3)).toEqual(generic)

    // An app's guide for anywhere joins the welcome at the front.
    const news = resolveGuides({
      ...own,
      guides: {
        ...own.guides,
        news: { title: 'New this month', where: 'anywhere', steps: [{ title: 't', body: 'b' }] },
      },
    })

    expect(news.map((g) => g.id).slice(0, 3)).toEqual(['welcome', 'news', 'pipeline'])
  })

  test("an app's guide for one object is offered there before the generic ones, and nowhere else", () => {
    const board: Place = { page: 'list', object: 'deals', board: true }
    expect(offer(board, ['welcome'], everything, resolved)).toBe('pipeline')
    expect(offer(board, ['welcome', 'pipeline'], everything, resolved)).toBe('list')
    expect(offer({ page: 'list', object: 'deals' }, ['welcome'], everything, resolved)).toBe('list')

    expect(offer({ page: 'record', object: 'deals' }, ['welcome'], everything, resolved)).toBe(
      'stage',
    )

    expect(offer({ page: 'record', object: 'contacts' }, ['welcome'], everything, resolved)).toBe(
      'record',
    )

    expect(offer({ page: 'workflows' }, ['welcome'], everything, resolved)).toBeNull()
    const seen = [...builtInGuides(config).map((g) => g.id), 'pipeline', 'stage']
    expect(offer(board, seen, everything, resolved)).toBeNull()
  })

  test('where to replay each guide', () => {
    const home = (id: string) =>
      homeOf(
        resolved.find((g) => g.id === id)!,
        own,
      )

    expect(home('welcome')).toEqual({})
    expect(home('tasks')).toEqual({ page: 'tasks' })
    expect(home('home')).toEqual({ page: 'home' })
    expect(home('search')).toEqual({ needs: 'search' })
    expect(home('list')).toEqual({ object: 'contacts' })
    expect(home('board')).toEqual({ object: 'deals', view: 'pipeline' })
    expect(home('pipeline')).toEqual({ object: 'deals', view: 'pipeline' })
    expect(home('record')).toEqual({ object: 'contacts', needs: 'record' })
    expect(home('stage')).toEqual({ object: 'deals', needs: 'record' })
  })

  const messages = (guidesKey: GuideConfig['guides']) =>
    checkGuides({ ...config, guides: guidesKey }).map((i) => `${i.path.join('.')}: ${i.message}`)

  const step = { title: 't', body: 'b' }

  test('mistakes are caught when the config is checked', () => {
    expect(messages({ extra: { title: 'x', steps: [step] } })[0]).toContain(
      'guides.extra.where: a new guide needs',
    )

    expect(messages({ extra: { title: 'x', where: 'kitchen', steps: [step] } })[0]).toContain(
      'unknown place "kitchen"',
    )

    expect(messages({ extra: { title: 'x', where: 'list:jobs', steps: [step] } })[0]).toContain(
      'unknown object "jobs"',
    )

    expect(
      messages({ extra: { title: 'x', where: 'board:contacts', steps: [step] } })[0],
    ).toContain('no board view')

    expect(messages({ nope: false })[0]).toContain('no built-in guide "nope"')

    expect(
      messages({
        extra: { title: 'x', where: 'record:deals', steps: [{ ...step, target: 'field:stagee' }] },
      })[0],
    ).toContain('guides.extra.steps.0.target: "stagee" is not a field of deals')

    expect(
      messages({
        extra: { title: 'x', where: 'list', steps: [{ ...step, target: 'veiw-menu' }] },
      })[0],
    ).toContain('unknown anchor "veiw-menu"')

    expect(messages({ list: { title: 'x', where: 'record:nope', steps: [step] } })[0]).toContain(
      'unknown object "nope"',
    )
  })

  test('a field on a guide for every object is not a mistake: the step is left out where the field is missing', () => {
    expect(
      messages({
        extra: { title: 'x', where: 'record', steps: [{ ...step, target: 'field:stage' }] },
      }),
    ).toEqual([])

    expect(isAnchor('field:stage', config, 'contacts')).toBe(false)
    expect(isAnchor('nav:deals', config)).toBe(true)
    expect(isAnchor('nav:tasks', config)).toBe(true)
    expect(isAnchor('nav:jobs', config)).toBe(false)
    expect(isAnchor('tab:files', config)).toBe(true)
    expect(isAnchor('tab:deals.contact', config)).toBe(true)
    expect(isAnchor('tab:deals.nope', config)).toBe(false)
  })

  test('the config schema runs the same checks', () => {
    const withGuides = (value: unknown) => crmConfigSchema.safeParse({ ...raw, guides: value })
    expect(withGuides(own.guides && { welcome: own.guides.welcome }).success).toBe(true)
    const bad = withGuides({ extra: { title: 'x', where: 'kitchen', steps: [step] } })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(['guides', 'extra', 'where'])
    expect(withGuides({ extra: { title: 'x', where: 'home', steps: [] } }).success).toBe(false)
    // A config that says nothing about guides has the built-in ones, unchanged.
    expect(crmConfigSchema.parse({ ...raw, guides: undefined }).guides).toEqual({})
  })
})
