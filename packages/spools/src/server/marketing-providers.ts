import { z } from 'zod'

import type { CrmMarketing } from '../crm/config-schema'
import type { IntegrationProvider } from './integrations'
import { crmConfig, spool } from './spool'

/**
 * The accounts the built-in marketing networks post and read through, as
 * providers for the Integrations page. One is offered only while a channel or
 * an ad account in crm.config.json uses its network directly, so a Spool that
 * does no marketing sees none of them.
 *
 * Each needs an OAuth app of your own with the network, as Google and
 * Microsoft do for mailboxes: its client id and secret in the environment, and
 * `{APP_URL}/api/integrations/<id>/callback` as a redirect address. See docs/marketing.md.
 */

/** A field of a provider's answer that names the account: a non-empty string, or nothing. */
const name = z.string().min(1).optional().catch(undefined)

const LinkedInUser = z.object({ email: name, sub: name })
const XUser = z.object({ data: z.object({ username: name }).optional().catch(undefined) })
const GoogleUser = z.object({ email: name })

/** The built-in network each provider serves: `posts` and `ads` are keys of `marketing.channels[].network` and `marketing.ads[].network`. */
export const NETWORK_PROVIDERS = {
  posts: { linkedin: 'linkedin', x: 'x' },
  ads: { google: 'google_ads' },
} as const

/** A marketing account is the team's to post through, whoever connected it. */
const SHARED = 'Anyone on the team can publish through it from the Marketing page'

/**
 * Whose these connections are: the team's (integrations.ts). They were used by
 * everyone before a connection said whose it was, so the ones made then are the
 * team's as well, without their rows being touched.
 */
const team = { shared: 'team', adoptExisting: true } as const

const linkedin = (pages: boolean): IntegrationProvider => ({
  ...team,
  label: 'LinkedIn',
  // Said on the Integrations page, whose other accounts are only their owner's to use.
  description: `${pages ? 'Post to your company page' : 'Post to LinkedIn'}. ${SHARED}`,
  clientId: 'LINKEDIN_CLIENT_ID',
  clientSecret: 'LINKEDIN_CLIENT_SECRET',
  authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
  tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  // A page needs the Community Management API, which LinkedIn reviews. A person's own posts do not.
  scopes: ['openid', 'profile', 'email', pages ? 'w_organization_social' : 'w_member_social'],
  // LinkedIn gives most apps a 60-day access token and no refresh token.
  refreshToken: 'optional',
  account: async ({ get }) => {
    const me = LinkedInUser.safeParse(await get('https://api.linkedin.com/v2/userinfo')).data
    return me?.email ?? me?.sub
  },
})

const x: IntegrationProvider = {
  ...team,
  label: 'X',
  description: `Post from your X account. ${SHARED}`,
  clientId: 'X_CLIENT_ID',
  clientSecret: 'X_CLIENT_SECRET',
  authUrl: 'https://x.com/i/oauth2/authorize',
  tokenUrl: 'https://api.x.com/2/oauth2/token',
  tokenAuth: 'basic',
  // offline.access is what makes X issue a refresh token.
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  account: async ({ get }) =>
    XUser.safeParse(await get('https://api.x.com/2/users/me')).data?.data?.username,
  revokeUrl: 'https://api.x.com/2/oauth2/revoke',
}

const googleAds: IntegrationProvider = {
  ...team,
  label: 'Google Ads',
  description:
    'Read what your campaigns spent and brought in. Everyone on the team sees the results',
  // The same OAuth client the Google mailbox uses, with one more redirect address and the Google Ads API enabled.
  clientId: 'GOOGLE_CLIENT_ID',
  clientSecret: 'GOOGLE_CLIENT_SECRET',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['openid', 'email', 'https://www.googleapis.com/auth/adwords'],
  authParams: { access_type: 'offline', prompt: 'consent' },
  account: async ({ get }) =>
    GoogleUser.safeParse(await get('https://openidconnect.googleapis.com/v1/userinfo')).data?.email,
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
}

/**
 * The providers a marketing block uses: one for each built-in network a channel or ad account reaches directly.
 * `canManage` is the app's rule for who may connect and disconnect them (`marketing.canManage` in
 * src/app/extensions.ts); without one, anyone on the access list may.
 */
export function providersFor(
  marketing: CrmMarketing | undefined,
  canManage?: IntegrationProvider['canManage'],
) {
  const offered: [string, IntegrationProvider][] = []

  if (!marketing) {
    return Object.fromEntries(offered)
  }

  const direct = Object.values(marketing.channels).filter((c) => c.via !== 'swirls')
  const onLinkedIn = direct.filter((c) => c.network === 'linkedin')

  if (onLinkedIn.length > 0) {
    offered.push([
      NETWORK_PROVIDERS.posts.linkedin,
      linkedin(onLinkedIn.some((c) => c.account.startsWith('urn:li:organization:'))),
    ])
  }

  if (direct.some((c) => c.network === 'x')) {
    offered.push([NETWORK_PROVIDERS.posts.x, x])
  }

  if (Object.values(marketing.ads).some((a) => a.via !== 'swirls' && a.network === 'google')) {
    offered.push([NETWORK_PROVIDERS.ads.google, googleAds])
  }

  return Object.fromEntries(
    offered.map(([id, p]): [string, IntegrationProvider] => [
      id,
      canManage === undefined ? p : { ...p, canManage },
    ]),
  )
}

/** The providers the config's marketing uses now, managed by whoever the app says: none without a `marketing` block. */
export const marketingProviders = () =>
  providersFor(crmConfig().marketing, spool().extensions.marketing?.canManage)
