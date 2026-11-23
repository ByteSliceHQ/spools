import { afterAll, expect, test } from 'bun:test'

import { NO_OFFERS, resolveGuides } from '../../src/crm/guides'
import * as guides from '../../src/server/guides'
import { crmConfig } from '../../src/server/spool'
import { GuideProgress } from '../../src/server/store/tables'
import { db, failure, run } from '../support/run'

// What each person has seen of the guides, against a real database. These use
// whatever guides the app has, so they run for any config.
const tag = `guides${Date.now()}`
const ana = `user_${tag}_ana`
const ben = `user_${tag}_ben`
const [first, second] = resolveGuides(crmConfig()).map((g) => g.id) as [string, string]

afterAll(async () => {
  for (const userId of [ana, ben]) {
    await db.remove(GuideProgress, { where: { userId } })
  }
})

const rows = (userId: string) => db.find(GuideProgress, { where: { userId } })

test('a new person has seen nothing', async () => {
  expect(await run(guides.seenGuides(ana))).toEqual([])
})

test('finishing or dismissing a guide is remembered', async () => {
  await run(guides.markGuide(ana, first, 'finished'))
  await run(guides.markGuide(ana, second, 'dismissed'))
  expect((await run(guides.seenGuides(ana))).sort()).toEqual([first, second].sort())
})

test('answering twice keeps one row and the first outcome', async () => {
  await run(guides.markGuide(ana, first, 'dismissed'))

  await Promise.all([
    run(guides.markGuide(ana, first, 'dismissed')),
    run(guides.markGuide(ana, first, 'finished')),
  ])

  const kept = (await rows(ana)).filter((r) => r.guideId === first)
  expect(kept).toHaveLength(1)
  expect(kept[0]?.outcome).toBe('finished')
})

test('two tabs answering a new guide at once leave one row', async () => {
  await db.remove(GuideProgress, { where: { userId: ben } })

  await Promise.all([
    run(guides.markGuide(ben, first, 'dismissed')),
    run(guides.markGuide(ben, first, 'dismissed')),
  ])

  expect((await rows(ben)).filter((r) => r.guideId === first)).toHaveLength(1)
  await db.remove(GuideProgress, { where: { userId: ben } })
})

test("one person's progress is not another's to read or change", async () => {
  // Ana has seen two guides; Ben has seen none of them.
  expect(await run(guides.seenGuides(ben))).toEqual([])

  // What Ben does changes only Ben's rows.
  await run(guides.markGuide(ben, second, 'finished'))
  await run(guides.setGuideOffers(ben, false))
  expect((await run(guides.seenGuides(ben))).sort()).toEqual([NO_OFFERS, second].sort())
  expect((await run(guides.seenGuides(ana))).sort()).toEqual([first, second].sort())
  expect((await rows(ana)).find((r) => r.guideId === second)?.outcome).toBe('dismissed')

  // Ben turning offers back on does not touch Ana's switch.
  await run(guides.setGuideOffers(ana, false))
  await run(guides.setGuideOffers(ben, true))
  expect(await run(guides.seenGuides(ben))).toEqual([second])
  expect(await run(guides.seenGuides(ana))).toContain(NO_OFFERS)
  await run(guides.setGuideOffers(ana, true))
  expect(await run(guides.seenGuides(ana))).not.toContain(NO_OFFERS)
})

test('the browser cannot say whose progress it is', () => {
  // The server functions validate with these: a user id sent along is dropped,
  // and the handler uses the signed-in person's.
  const sent = { id: first, outcome: 'dismissed', userId: ana, user_id: ana }
  expect(guides.markInput.parse(sent)).toEqual({ id: first, outcome: 'dismissed' })
  expect(guides.offersInput.parse({ on: false, userId: ana })).toEqual({ on: false })
})

test("only this CRM's guides can be recorded", async () => {
  expect(guides.markInput.safeParse({ id: 'notAGuide', outcome: 'dismissed' }).success).toBe(false)
  expect(guides.markInput.safeParse({ id: first, outcome: 'skipped' }).success).toBe(false)
  // The "don't offer" marker has its own switch; it can't be written as a guide.
  expect(guides.markInput.safeParse({ id: NO_OFFERS, outcome: 'dismissed' }).success).toBe(false)
  const refused = await failure(guides.markGuide(ana, 'notAGuide', 'dismissed'))
  expect(refused._tag).toBe('Invalid')
  // What staff would read, word for word.
  expect(refused.message).toBe('Unknown guide "notAGuide"')
  expect(await run(guides.seenGuides(ana))).not.toContain('notAGuide')
})

test('turning offers off twice, or on when they were never off, is harmless', async () => {
  await run(guides.setGuideOffers(ben, true))
  await run(guides.setGuideOffers(ben, false))
  await run(guides.setGuideOffers(ben, false))
  expect((await rows(ben)).filter((r) => r.guideId === NO_OFFERS)).toHaveLength(1)
  await run(guides.setGuideOffers(ben, true))
  expect(await run(guides.seenGuides(ben))).toEqual([second])
})
