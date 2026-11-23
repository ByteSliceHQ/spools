import { AsyncLocalStorage } from 'node:async_hooks'

import type { BetterAuthOptions } from 'better-auth/minimal'
import { type OAuth2Tokens, type OAuth2UserInfo, refreshAccessToken } from 'better-auth/oauth2'
import { Option, Schema } from 'effect'

import type { Client, Settings } from './settings'

/**
 * Signing in with Google and Microsoft: what each is asked for, and when its
 * word about an address is taken. An address neither vouches for is treated as
 * no address at all, so it can't open the access list, be matched with an
 * account that is already here, or be used to find out who has one.
 */

/** A profile's claims, as they come from the provider's ID token: any JSON at all, so each is checked. */
const Claims = Schema.Record(Schema.String, Schema.Json)

type Profile = typeof Claims.Type

const isText = Schema.is(Schema.String)

/** Microsoft's names for "people of any organization", "personal accounts", and both. */
const ANYONE = new Set(['common', 'organizations', 'consumers'])
const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/**
 * Whether Microsoft vouches for the address in a profile.
 *
 * Any organization can put any address in its own people's profiles, so when
 * people of any organization may sign in, the address counts only with a claim
 * that says who owns it: `xms_edov`, or being listed as a verified address.
 * (They are optional claims, added in the app's registration.) With one
 * organization set, the profiles are that organization's own records, which
 * only its administrators can change, and its word is taken.
 */
export function microsoftVouches(profile: Profile, tenant: string): boolean {
  const email = profile['email']

  if (!isText(email) || !email) {
    return false
  }

  if (!ANYONE.has(tenant.toLowerCase())) {
    const tid = profile['tid']
    return !GUID.test(tenant) || (isText(tid) && tid.toLowerCase() === tenant.toLowerCase())
  }

  const owned = profile['xms_edov']

  if (owned === true || owned === 1 || owned === '1' || owned === 'true') {
    return true
  }

  return [profile['verified_primary_email'], profile['verified_secondary_email']]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .some((verified) => isText(verified) && verified.toLowerCase() === email.toLowerCase())
}

/** What a provider said when it wouldn't renew a token. Better Auth's own error leaves it out. */
export const renewal = new AsyncLocalStorage<Renewal>()

/** Where a refusal to renew is kept for whoever asked for the token. */
export type Renewal = { refused?: unknown }

const renew = (tokenEndpoint: string, client: Client) => async (refreshToken: string) => {
  try {
    // No `scope`: what was granted stays granted. (Better Auth would ask Microsoft for its sign-in scopes
    // only, and a personal account's new token could then no longer read mail.)
    return await refreshAccessToken({ refreshToken, options: client, tokenEndpoint })
  } catch (cause) {
    const box = renewal.getStore()

    if (box) {
      box.refused = cause
    }

    throw cause
  }
}

const shared = {
  // People choose the account each time: theirs at work is often not the only one they are signed in to.
  prompt: 'select_account',
  // A sign-in happens at the provider's own page, never with a token someone hands to this server.
  disableIdTokenSignIn: true,
  /** The account's address, for the mailbox pages. */
  getAccountFields: (_tokens: OAuth2Tokens, { email }: OAuth2UserInfo) => ({
    email: email?.toLowerCase(),
  }),
} as const

export const socialProviders = ({
  google,
  microsoft,
}: Pick<Settings, 'google' | 'microsoft'>): BetterAuthOptions['socialProviders'] => ({
  ...(google && {
    google: {
      ...google,
      ...shared,
      // A refresh token, so a mailbox can be read while nobody is looking.
      accessType: 'offline',
      refreshAccessToken: renew('https://oauth2.googleapis.com/token', google),
      // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- The type says boolean. What a provider sends may be the text "false".
      mapProfileToUser: (profile) => (profile.email_verified === true ? {} : { email: null }),
    },
  }),
  ...(microsoft && {
    microsoft: {
      clientId: microsoft.clientId,
      clientSecret: microsoft.clientSecret,
      tenantId: microsoft.tenant,
      ...shared,
      disableProfilePhoto: true,
      refreshAccessToken: renew(
        `https://login.microsoftonline.com/${encodeURIComponent(microsoft.tenant)}/oauth2/v2.0/token`,
        microsoft,
      ),
      // A profile that isn't JSON claims vouches for nothing.
      mapProfileToUser: (profile) =>
        Option.exists(Schema.decodeOption(Claims)(profile), (claims) =>
          microsoftVouches(claims, microsoft.tenant),
        )
          ? { emailVerified: true }
          : { email: null, emailVerified: false },
    },
  }),
})
