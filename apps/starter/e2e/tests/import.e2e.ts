import { expect, test } from '@playwright/test'

import { unique } from './app'

test('a CSV import reports the rows it refused and still creates the others', async ({ page }) => {
  const first = unique('Ivy Imported')
  const last = unique('Ian Imported')
  const refused = unique('Bea Badaddress')

  // Line 3 has an email that is not an address, and line 4 no name. The good rows are around them.
  const csv = [
    'Name,Email,Status',
    `${first},ivy@example.org,lead`,
    `${refused},not-an-address,lead`,
    ',nameless@example.org,lead',
    `${last},ian@example.org,customer`,
  ].join('\n')

  await page.goto('/contacts')
  await page.getByRole('button', { name: 'Import / Export' }).click()
  await page.getByRole('button', { name: 'Import CSV' }).click()

  const dialog = page.getByRole('dialog')

  await dialog
    .getByLabel('CSV file')
    .setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })

  await expect(dialog.getByText('4 rows to import')).toBeVisible()
  await expect(dialog.getByText('Matched: Name, Email, Status')).toBeVisible()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()

  await expect(dialog.getByText('Imported 2 contacts. 2 could not be imported.')).toBeVisible()
  const refusals = dialog.getByRole('listitem')
  await expect(refusals).toHaveCount(2)
  await expect(refusals.nth(0)).toHaveText('Row 3: email: Invalid email address')
  await expect(refusals.nth(1)).toHaveText('Row 4: name: Required')
  await dialog.getByRole('button', { name: 'Done' }).click()

  await page.reload()
  const table = page.getByRole('table')

  await expect(table.getByRole('link', { name: first, exact: true })).toBeVisible()
  await expect(table.getByRole('link', { name: last, exact: true })).toBeVisible()
  await expect(table.getByText(refused)).toHaveCount(0)
  await expect(table.getByText('nameless@example.org')).toHaveCount(0)
})
