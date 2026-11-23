/**
 * What the two halves of the adapter agree on. The browser reads this file, so
 * nothing belongs here but plain values.
 */

/** Where the server answers (src/routes/api/auth.$.ts). */
export const API = '/api/auth'

/** The sign-in page: where a link in an email opens, and where a sign-in that went wrong ends up. */
export const SIGN_IN = '/sign-in'

/**
 * The name a link's token has after the `#` of the sign-in page's address. What
 * follows a `#` stays in the browser: it isn't in server logs or sent on to
 * other sites.
 */
export const LINK = 'link'

/** Minutes a link works for. */
export const LINK_MINUTES = 10

/** Why this adapter refused someone, as `?error=` on the sign-in page. Better Auth has codes of its own besides. */
export const REFUSED = { notAllowed: 'not_allowed', unverified: 'email_not_verified' } as const
