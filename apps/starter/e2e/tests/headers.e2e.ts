import { expect, test } from '@playwright/test'

import { expectSecurityHeaders } from './app'

for (const path of ['/', '/contacts', '/deals', '/tasks', '/assistant']) {
  test(`the page at ${path} is served with the security headers`, async ({ page }) => {
    const response = await page.goto(path)

    expect(response?.status()).toBe(200)
    expect(response?.headers()['content-type']).toContain('text/html')
    expectSecurityHeaders(response?.headers() ?? {})
  })
}
