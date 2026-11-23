import { expect, test } from '@playwright/test'

import { detail, openRecord, timeline, unique } from './app'

test('the contacts list shows the seeded contacts, and one opens its record page', async ({
  page,
}) => {
  await page.goto('/contacts')
  const table = page.getByRole('table')

  for (const name of ['Ada Lovelace', 'Grace Hopper', 'Alan Turing']) {
    await expect(table.getByRole('link', { name, exact: true })).toBeVisible()
  }

  const ada = table.getByRole('row').filter({ hasText: 'Ada Lovelace' })
  await expect(ada.getByRole('link', { name: 'ada@initech.example' })).toBeVisible()
  await expect(ada.getByRole('link', { name: 'Initech', exact: true })).toBeVisible()
  await expect(ada.getByText('Qualified')).toBeVisible()

  await table.getByRole('link', { name: 'Ada Lovelace', exact: true }).click()

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible()
  await expect(detail(page, 'Email')).toHaveText('ada@initech.example')
  await expect(detail(page, 'Company')).toHaveText('Initech')
  await expect(detail(page, 'Status')).toHaveText('Qualified')
  await expect(page.getByText('Book a kickoff call with Ada')).toBeVisible()
})

test('a contact created in the interface is in the list, and its timeline says who created it', async ({
  page,
}) => {
  const name = unique('Nora Newcomer')

  await page.goto('/contacts')
  await page.getByRole('button', { name: 'New Contact', exact: true }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: /^Name/ }).fill(name)
  await dialog.getByRole('textbox', { name: /^Email/ }).fill('nora@example.org')
  await dialog.getByRole('combobox', { name: 'Status' }).selectOption('Customer')
  await dialog.getByRole('button', { name: 'Create contact' }).click()

  await expect(dialog).toBeHidden()
  const row = page.getByRole('table').getByRole('row').filter({ hasText: name })
  await expect(row.getByRole('link', { name: 'nora@example.org' })).toBeVisible()
  await expect(row.getByText('Customer')).toBeVisible()

  // Still there when the list is asked for again.
  await page.reload()
  await page.getByRole('link', { name, exact: true }).click()

  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(timeline(page).filter({ hasText: 'Dev User created this contact' })).toBeVisible()
})

test('an edited field keeps its new value after a reload, and the timeline records the change', async ({
  page,
}) => {
  const phone = `555-${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`

  await openRecord(page, '/contacts', 'Alan Turing')
  await detail(page, 'Phone').getByRole('button').click()
  await detail(page, 'Phone').getByRole('textbox').fill(phone)
  await detail(page, 'Phone').getByRole('textbox').press('Enter')

  // The panel shows what the server has, so this is the saved value.
  await expect(detail(page, 'Phone')).toHaveText(phone)

  await page.reload()

  await expect(detail(page, 'Phone')).toHaveText(phone)
  await expect(timeline(page).filter({ hasText: 'Dev User updated Phone' }).first()).toBeVisible()
})
