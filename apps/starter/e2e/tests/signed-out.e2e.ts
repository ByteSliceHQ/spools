import { expect, test } from '@playwright/test'

import { expectSecurityHeaders, SEEDED } from './app'

// This server runs with DEV_AUTH_SIGNED_OUT=1 (e2e/playwright.config.ts).
for (const path of ['/', '/contacts']) {
  test(`a signed-out visitor to ${path} is sent to sign in and sees no records`, async ({
    page,
    request,
  }) => {
    const response = await page.goto(path)

    await expect(page).toHaveURL(/\/sign-in$/)
    await expect(page.getByRole('heading', { name: 'Development sign-in' })).toBeVisible()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    expectSecurityHeaders(response?.headers() ?? {})

    // Neither what the browser ended up with nor what the server first answered holds a record.
    const first = await request.get(path, { maxRedirects: 0 })
    const sent = `${await page.content()}\n${await first.text()}`

    for (const word of SEEDED) {
      expect(sent).not.toContain(word)
    }
  })
}
