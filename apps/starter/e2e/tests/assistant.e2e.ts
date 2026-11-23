import { expect, test } from '@playwright/test'

import { unique } from './app'

// This server runs with E2E_ASSISTANT=stub: the replies are the canned ones in e2e/assistant-stub.ts.

test('a question gets the canned reply as it streams, and the chat is listed in the sidebar', async ({
  page,
}) => {
  const question = unique('Which contacts are new?')

  await page.goto('/assistant')
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message Assistant' }).fill(question)
  await page.getByRole('button', { name: 'Send' }).click()

  const main = page.getByRole('main')

  // While it streams: the question, the reply under way and a way to stop it.
  await expect(main.getByText(question)).toBeVisible()
  await expect(main.getByRole('status')).toHaveText('Assistant is replying')
  await expect(main.getByRole('button', { name: 'Stop the reply' })).toBeVisible()

  await expect(main.getByText('This is a canned reply from the local stub')).toBeVisible()
  await expect(main.getByRole('status')).toHaveText('Assistant replied')
  await expect(main.getByRole('button', { name: 'Took 2 steps' })).toBeVisible()

  // The stub's search step is a real one, so the reply names seeded contacts.
  await expect(main.getByRole('listitem').filter({ hasText: 'Ada Lovelace' })).toBeVisible()
  await expect(main.getByRole('button', { name: 'Regenerate' })).toBeVisible()

  await expect(page).toHaveURL(/\/assistant\?session=[0-9a-f-]{36}$/)

  await expect(
    page.getByRole('navigation', { name: 'Chats' }).getByRole('link', { name: question }),
  ).toBeVisible()
})

test('an image in a reply is shown as a link, and nothing is fetched from its address', async ({
  page,
  baseURL,
}) => {
  const elsewhere: string[] = []

  page.on('request', (request) => {
    if (!request.url().startsWith(String(baseURL))) {
      elsewhere.push(request.url())
    }
  })

  await page.goto('/assistant')
  await page.getByRole('textbox', { name: 'Message Assistant' }).fill('Show me an image')
  await page.getByRole('button', { name: 'Send' }).click()

  const main = page.getByRole('main')
  await expect(main.getByRole('status')).toHaveText('Assistant replied')
  await expect(main.getByText('Here is the chart.')).toBeVisible()

  const link = main.getByRole('link', { name: 'chart', exact: true })
  await expect(link).toHaveAttribute('href', 'https://example.com/a.png')
  await expect(link).toHaveAttribute('rel', /noreferrer/)
  await expect(page.locator('img')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'chart' })).toHaveCount(0)
  expect(elsewhere).toEqual([])
})
