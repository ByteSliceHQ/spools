/** What the tests share: the seeded records (scripts/seed.ts) and how a record page is read. */
import { expect, type Locator, type Page } from '@playwright/test'

/** A word from every seeded company, contact and deal. None may reach someone who is refused. */
export const SEEDED = ['Initech', 'Globex', 'Lovelace', 'Hopper', 'Turing', 'initech.example']

/** Different on every call, so a test's records are its own however often it runs. */
export const unique = (name: string) => `${name} ${crypto.randomUUID().slice(0, 8)}`

/** The headers every page is served with (packages/spools/src/server/headers.ts). */
export function expectSecurityHeaders(headers: Readonly<Record<string, string>>) {
  expect(headers['x-frame-options']).toBe('SAMEORIGIN')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['content-security-policy']).toContain("frame-ancestors 'self'")
}

/** Open a record from its object's list. */
export async function openRecord(page: Page, list: string, title: string) {
  await page.goto(list)
  await page.getByRole('link', { name: title, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

/** The value beside a field's name in a record's details panel. */
export const detail = (page: Page, label: string): Locator =>
  page
    .getByRole('main')
    .getByRole('complementary')
    .getByRole('term')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd')

/** The entries of a record's timeline, newest first. */
export const timeline = (page: Page): Locator => page.getByRole('main').getByRole('listitem')
