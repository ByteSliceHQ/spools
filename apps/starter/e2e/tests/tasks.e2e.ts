import { expect, test } from '@playwright/test'

import { openRecord, timeline, unique } from './app'

test('a task added to a record is on the Tasks page, linked to that record', async ({ page }) => {
  const task = unique('Call Grace about the renewal')

  await openRecord(page, '/contacts', 'Grace Hopper')
  await page.getByRole('button', { name: 'Add task', exact: true }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('New task for Grace Hopper')).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Task', exact: true }).fill(task)
  await dialog.getByRole('button', { name: 'Create task' }).click()

  await expect(dialog).toBeHidden()
  await expect(timeline(page).filter({ hasText: `added a task: ${task}` })).toBeVisible()
  await expect(page.getByRole('main').getByText(task, { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Tasks', exact: true }).click()

  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByRole('main').getByText(task, { exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: 'Grace Hopper' })).toBeVisible()

  // Seeded tasks are assigned to nobody, so they are under "All tasks" beside this one.
  await page.getByRole('link', { name: 'All tasks' }).click()

  await expect(page.getByRole('main').getByText(task, { exact: true })).toBeVisible()
  await expect(page.getByRole('main').getByText('Book a kickoff call with Ada')).toBeVisible()
})
