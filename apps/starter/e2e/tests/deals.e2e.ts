import { expect, type Page, test } from '@playwright/test'

import { detail, timeline } from './app'

const column = (page: Page, stage: string) => page.getByRole('region', { name: stage, exact: true })

const card = (page: Page, stage: string, title: string) =>
  column(page, stage).getByRole('link', { name: new RegExp(`^${title}`) })

test('the board has the seeded deals in their stages, and a dragged deal stays where it was dropped', async ({
  page,
}) => {
  await page.goto('/deals')

  await expect(card(page, 'Proposal', 'Initech platform rollout')).toBeVisible()
  await expect(card(page, 'Negotiation', 'Globex expansion')).toBeVisible()
  await expect(card(page, 'Won', 'Globex pilot')).toBeVisible()
  await expect(column(page, 'Discovery').getByRole('link')).toHaveCount(0)
  await expect(column(page, 'Lost').getByRole('link')).toHaveCount(0)

  // The card moves before the server answers, so wait for the save itself before reloading.
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && (r.request().postData() ?? '').includes('"discovery"'),
  )

  await card(page, 'Proposal', 'Initech platform rollout').dragTo(column(page, 'Discovery'))

  expect((await saved).ok()).toBe(true)
  await expect(card(page, 'Discovery', 'Initech platform rollout')).toBeVisible()

  await page.reload()

  await expect(card(page, 'Discovery', 'Initech platform rollout')).toBeVisible()
  await expect(column(page, 'Proposal').getByRole('link')).toHaveCount(0)
  await expect(card(page, 'Negotiation', 'Globex expansion')).toBeVisible()

  await card(page, 'Discovery', 'Initech platform rollout').click()

  await expect(detail(page, 'Stage')).toHaveText('Discovery')

  await expect(
    timeline(page).filter({ hasText: 'Dev User changed Stage to Discovery' }),
  ).toBeVisible()
})
