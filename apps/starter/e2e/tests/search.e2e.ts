import { expect, test } from '@playwright/test'

test('the search box finds a seeded contact by one word of its name and opens it', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^Search/ }).click()

  const search = page.getByRole('dialog', { name: 'Search' })
  await search.getByRole('combobox', { name: 'Search the CRM' }).fill('Lovelace')

  const results = search.getByRole('listbox', { name: 'Results' })
  await expect(results.getByRole('option')).toHaveCount(1)
  await results.getByRole('option', { name: /Ada Lovelace/ }).click()

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeVisible()
  await expect(search).toBeHidden()
})
