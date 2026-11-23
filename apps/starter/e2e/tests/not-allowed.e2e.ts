import { expect, test } from '@playwright/test'

import { expectSecurityHeaders, SEEDED } from './app'

// This server signs everyone in as otto@elsewhere.test, who the access list in crm.config.json refuses.
for (const path of ['/', '/contacts']) {
  test(`someone not on the access list is refused at ${path} and sees no records`, async ({
    page,
  }) => {
    const response = await page.goto(path)
    // A refusal, not a fault of the server's.
    expect(response?.status()).toBe(403)

    await expect(
      page.getByRole('heading', { name: "You don't have access to this CRM" }),
    ).toBeVisible()

    await expect(page.getByText("isn't on the allowlist")).toBeVisible()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    await expect(page.getByRole('table')).toHaveCount(0)
    expectSecurityHeaders(response?.headers() ?? {})

    const sent = await page.content()

    for (const word of SEEDED) {
      expect(sent).not.toContain(word)
    }
  })
}
