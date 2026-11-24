import { Data, Effect } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { z } from 'zod'

import type {
  AdCampaignResults,
  NetworkAccess,
  PostToPublish,
  PublishedPost,
} from '../crm/extensions'
import { AD_LABELS, POST_SPECS, type PostSpec } from '../crm/marketing'
import { findConnections, getAccessToken, providerReady, providers } from './integrations'
import { NETWORK_PROVIDERS } from './marketing-providers'
import * as config from './runtime/config'
import { fromHook, messageOf } from './runtime/errors'
import { type Json, parseJson } from './runtime/json'
import { policies, withPolicy } from './runtime/policies'
import { crmConfig, spool } from './spool'

/**
 * The networks the Marketing page can reach, and how.
 *
 * A network is a key (`linkedin`, `meta`) with what the page needs to know of
 * it and, when the CRM can call it itself, the code that does. The built-in
 * ones are here. An app adds its own, or replaces a built-in one, under
 * `marketing` in src/app/extensions.ts. A network with no code of its own is
 * still usable: a channel with `"via": "swirls"` hands the post to a
 * `publish_<network>` workflow of the agent engine instead (marketing.ts).
 *
 * The built-in networks talk to each API as its reference describes. None has
 * been run against a live account yet.
 */

/**
 * A network said no, or could not be asked. `uncertain` is for a post whose
 * fate is unknown (no answer, or a server error after it was sent): it may
 * have gone out, so nobody should send it again without looking.
 */
export class NetworkFailure extends Data.TaggedError('NetworkFailure')<{
  message: string
  uncertain: boolean
}> {}

const refuse = (message: string, uncertain = false) =>
  Effect.fail(new NetworkFailure({ message, uncertain }))

type Reach = HttpClient.HttpClient

export type PostNetworkDef = PostSpec & {
  access?: NetworkAccess
  publish?: (post: PostToPublish) => Effect.Effect<PublishedPost, NetworkFailure, Reach>
}

export type AdNetworkDef = {
  label: string
  access?: NetworkAccess
  read?: (ctx: {
    account: string
    token: string | null
    days: number
  }) => Effect.Effect<AdCampaignResults[], NetworkFailure, Reach>
}

type Answer = { status: number; headers: Readonly<Record<string, string>>; body: Json | undefined }

const said = z.string().min(1).optional().catch(undefined)

/** Where an API usually puts what went wrong, across the networks here. */
const Complaint = z.object({
  message: said,
  detail: said,
  title: said,
  error: z
    .union([z.string().min(1), z.object({ message: said })])
    .optional()
    .catch(undefined),
})

/** The network's own words for a refusal, when its answer has any. */
function complaintOf(body: Json | undefined): string {
  const parsed = Complaint.safeParse(body).data
  const error = parsed?.error
  const nested = error === undefined ? undefined : z.string().safeParse(error).data
  const inner = z.object({ message: said }).safeParse(error).data?.message
  return parsed?.message ?? nested ?? inner ?? parsed?.detail ?? parsed?.title ?? ''
}

/**
 * One call to a network's API. A read is tried again when the network can't be
 * reached; a write never is. An answer of 400 or more is a failure in the
 * network's own words, and for a write a 5xx is an uncertain one.
 */
const call = (
  label: string,
  request: HttpClientRequest.HttpClientRequest,
  kind: 'read' | 'write',
): Effect.Effect<Answer, NetworkFailure, Reach> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const res = yield* client.execute(request)
    const text = yield* res.text
    return { status: res.status, headers: res.headers, body: parseJson(text) }
  }).pipe(
    withPolicy(policies.marketingApi, () => kind === 'read'),
    Effect.catch((error) =>
      refuse(
        error._tag === 'Timeout'
          ? `${label} did not answer in time`
          : `${label} could not be reached`,
        kind === 'write',
      ),
    ),
    Effect.flatMap((answer) => {
      if (answer.status < 400) {
        return Effect.succeed(answer)
      }

      const words = complaintOf(answer.body).slice(0, 300)

      return refuse(
        `${label} answered ${answer.status}${words ? `: ${words}` : ''}`,
        kind === 'write' && answer.status >= 500,
      )
    }),
  )

const bearer = (token: string | null) => ({
  authorization: `Bearer ${token ?? ''}`,
  accept: 'application/json',
})

const getJson = (label: string, url: string, token: string | null) =>
  call(label, HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(bearer(token))), 'read')

const postJson = (
  label: string,
  url: string,
  token: string | null,
  body: Json,
  kind: 'read' | 'write',
  headers: Record<string, string> = {},
) =>
  call(
    label,
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ ...bearer(token), ...headers }),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
    kind,
  )

const id = z.union([z.string().min(1), z.number().transform(String)])

/** A published post's id, or a failure that says the answer had none: the post may be out, so it is uncertain. */
const publishedId = (label: string, found: string | undefined) =>
  found === undefined
    ? refuse(`${label} accepted the post but did not say where it is`, true)
    : Effect.succeed(found)

const linkedin: PostNetworkDef = {
  ...POST_SPECS.linkedin,
  access: { integration: NETWORK_PROVIDERS.posts.linkedin },
  publish: (post) =>
    Effect.gen(function* () {
      const answer = yield* postJson(
        'LinkedIn',
        'https://api.linkedin.com/v2/ugcPosts',
        post.token,
        {
          author: post.account,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text: post.text },
              shareMediaCategory: 'NONE',
            },
          },
          visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
        },
        'write',
        { 'x-restli-protocol-version': '2.0.0' },
      )

      const found = yield* publishedId(
        'LinkedIn',
        z.object({ id }).safeParse(answer.body).data?.id ?? answer.headers['x-restli-id'],
      )

      return { id: found, url: `https://www.linkedin.com/feed/update/${found}` }
    }),
}

const x: PostNetworkDef = {
  ...POST_SPECS.x,
  access: { integration: NETWORK_PROVIDERS.posts.x },
  publish: (post) =>
    Effect.gen(function* () {
      const answer = yield* postJson(
        'X',
        'https://api.x.com/2/tweets',
        post.token,
        { text: post.text },
        'write',
      )

      const found = yield* publishedId(
        'X',
        z.object({ data: z.object({ id }) }).safeParse(answer.body).data?.data.id,
      )

      return { id: found, url: `https://x.com/i/web/status/${found}` }
    }),
}

const GRAPH = 'https://graph.facebook.com'
/** A system user's token from Meta Business settings: it does not expire, and it is the business's, not a person's. */
const META_TOKEN = 'META_ACCESS_TOKEN'

const facebook: PostNetworkDef = {
  ...POST_SPECS.facebook,
  access: { env: META_TOKEN },
  publish: (post) =>
    Effect.gen(function* () {
      const page = encodeURIComponent(post.account)

      // A post is made as the page, with the page's own token, which the business's token can ask for.
      const asked = yield* getJson('Facebook', `${GRAPH}/${page}?fields=access_token`, post.token)

      const pageToken =
        z.object({ access_token: said }).safeParse(asked.body).data?.access_token ?? post.token

      const answer = yield* postJson(
        'Facebook',
        `${GRAPH}/${page}/feed`,
        pageToken,
        post.link ? { message: post.body, link: post.link } : { message: post.body },
        'write',
      )

      const found = yield* publishedId('Facebook', z.object({ id }).safeParse(answer.body).data?.id)
      return { id: found, url: `https://www.facebook.com/${found}` }
    }),
}

const amount = z.coerce.number().catch(0)

const MetaCampaigns = z.object({
  data: z
    .array(
      z.object({
        id,
        name: said,
        effective_status: said,
        daily_budget: z.coerce.number().optional().catch(undefined),
      }),
    )
    .catch([]),
})

const MetaInsights = z.object({
  data: z
    .array(
      z.object({
        campaign_id: id,
        spend: amount,
        impressions: amount,
        clicks: amount,
        account_currency: said,
        actions: z
          .array(z.object({ action_type: z.string(), value: amount }))
          .optional()
          .catch(undefined),
      }),
    )
    .catch([]),
})

const metaDays = new Map([
  [7, 'last_7d'],
  [14, 'last_14d'],
  [30, 'last_30d'],
  [90, 'last_90d'],
])

const meta: AdNetworkDef = {
  label: AD_LABELS.meta,
  access: { env: META_TOKEN },
  read: ({ account, token, days }) =>
    Effect.gen(function* () {
      const act = `act_${encodeURIComponent(account.replace(/^act_/, ''))}`

      const [listed, results] = yield* Effect.all([
        getJson(
          'Meta Ads',
          `${GRAPH}/${act}/campaigns?fields=id,name,effective_status,daily_budget&limit=200`,
          token,
        ),
        getJson(
          'Meta Ads',
          `${GRAPH}/${act}/insights?level=campaign&date_preset=${metaDays.get(days) ?? 'last_30d'}` +
            '&fields=campaign_id,spend,impressions,clicks,actions,account_currency&limit=200',
          token,
        ),
      ])

      const insights = new Map(
        (MetaInsights.safeParse(results.body).data?.data ?? []).map((row) => [
          row.campaign_id,
          row,
        ]),
      )

      return (MetaCampaigns.safeParse(listed.body).data?.data ?? []).map((campaign) => {
        const row = insights.get(campaign.id)

        return {
          externalId: campaign.id,
          name: campaign.name ?? campaign.id,
          status: campaign.effective_status ?? 'unknown',
          currency: row?.account_currency ?? null,
          spend: row?.spend ?? 0,
          impressions: row?.impressions ?? 0,
          clicks: row?.clicks ?? 0,
          // A result is a lead, as Meta counts one.
          conversions: row?.actions?.find((a) => a.action_type === 'lead')?.value ?? 0,
          // Meta gives budgets in the currency's smallest unit.
          dailyBudget: campaign.daily_budget === undefined ? null : campaign.daily_budget / 100,
        }
      })
    }),
}

/** The Google Ads API version asked for when GOOGLE_ADS_API_VERSION is not set. Google retires each a year after its release. */
const GOOGLE_ADS_VERSION = 'v26'

const GoogleRows = z.object({
  results: z
    .array(
      z.object({
        campaign: z.object({ id, name: said, status: said }),
        customer: z.object({ currencyCode: said }).optional().catch(undefined),
        campaignBudget: z
          .object({ amountMicros: z.coerce.number().optional().catch(undefined) })
          .optional()
          .catch(undefined),
        metrics: z
          .object({ costMicros: amount, impressions: amount, clicks: amount, conversions: amount })
          .partial()
          .optional()
          .catch(undefined),
      }),
    )
    .catch([]),
})

const google: AdNetworkDef = {
  label: AD_LABELS.google,
  access: { integration: NETWORK_PROVIDERS.ads.google },
  read: ({ account, token, days }) =>
    Effect.gen(function* () {
      const developerToken = yield* config.variable('GOOGLE_ADS_DEVELOPER_TOKEN')

      if (!developerToken) {
        return yield* refuse(
          'Set GOOGLE_ADS_DEVELOPER_TOKEN: Google Ads asks for it with every call',
        )
      }

      const version = (yield* config.variable('GOOGLE_ADS_API_VERSION')) ?? GOOGLE_ADS_VERSION
      const manager = yield* config.variable('GOOGLE_ADS_LOGIN_CUSTOMER_ID')
      const customer = account.replaceAll('-', '')
      const sent: [string, string][] = [['developer-token', developerToken]]

      // An account reached through a manager account names the manager too.
      if (manager) {
        sent.push(['login-customer-id', manager.replaceAll('-', '')])
      }

      const headers = Object.fromEntries(sent)

      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      const until = new Date().toISOString().slice(0, 10)

      const answer = yield* postJson(
        'Google Ads',
        `https://googleads.googleapis.com/${encodeURIComponent(version)}/customers/${encodeURIComponent(customer)}/googleAds:search`,
        token,
        {
          query:
            'SELECT campaign.id, campaign.name, campaign.status, customer.currency_code, ' +
            'campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, ' +
            'metrics.clicks, metrics.conversions FROM campaign ' +
            `WHERE segments.date BETWEEN '${since}' AND '${until}'`,
        },
        'read',
        headers,
      )

      return (GoogleRows.safeParse(answer.body).data?.results ?? []).map((row) => ({
        externalId: row.campaign.id,
        name: row.campaign.name ?? row.campaign.id,
        status: row.campaign.status ?? 'unknown',
        currency: row.customer?.currencyCode ?? null,
        spend: (row.metrics?.costMicros ?? 0) / 1_000_000,
        impressions: row.metrics?.impressions ?? 0,
        clicks: row.metrics?.clicks ?? 0,
        conversions: row.metrics?.conversions ?? 0,
        dailyBudget:
          row.campaignBudget?.amountMicros === undefined
            ? null
            : row.campaignBudget.amountMicros / 1_000_000,
      }))
    }),
}

const builtInPosts = new Map<string, PostNetworkDef>([
  ['linkedin', linkedin],
  ['x', x],
  ['facebook', facebook],
])

const builtInAds = new Map<string, AdNetworkDef>([
  ['meta', meta],
  ['google', google],
])

/** An app's own code threw: its words reach the team, and a post it was sending may have gone out. */
const fromApp = <A>(what: string, run: () => Promise<A>, uncertain: boolean) =>
  fromHook(what, run).pipe(
    Effect.mapError((error) => new NetworkFailure({ message: messageOf(error.cause), uncertain })),
  )

/** A network posts can go to: the app's own of that key, else the built-in one. */
export function postNetwork(key: string): PostNetworkDef | undefined {
  const own = spool().extensions.marketing?.posts ?? {}

  if (Object.hasOwn(own, key)) {
    const def = own[key]
    const publish = def?.publish

    return (
      def && {
        label: def.label,
        limit: def.limit,
        linkLength: def.linkLength,
        access: def.access,
        publish:
          publish && ((post) => fromApp(`marketing.posts.${key}`, () => publish(post), true)),
      }
    )
  }

  return builtInPosts.get(key)
}

/** An ad network: the app's own of that key, else the built-in one. */
export function adNetwork(key: string): AdNetworkDef | undefined {
  const own = spool().extensions.marketing?.ads ?? {}

  if (Object.hasOwn(own, key)) {
    const def = own[key]
    const read = def?.read

    return (
      def && {
        label: def.label,
        access: def.access,
        read: read && ((ctx) => fromApp(`marketing.ads.${key}`, () => read(ctx), false)),
      }
    )
  }

  return builtInAds.get(key)
}

const labelOf = (provider: string) =>
  Object.hasOwn(providers(), provider) ? (providers()[provider]?.label ?? provider) : provider

/**
 * The token a network's code needs: from the environment, or from a
 * teammate's connection. Any connected teammate's account will do, and
 * `prefer` (whoever approved the post) is tried first. Null for a network
 * that names no access.
 */
export const accessToken = Effect.fn('marketingNetworks.accessToken')(function* (
  access: NetworkAccess | undefined,
  prefer?: string | null,
) {
  if (!access) {
    return null
  }

  if ('env' in access) {
    const token = yield* config.variable(access.env)
    return token ? token : yield* refuse(`Set ${access.env} in the CRM's environment`)
  }

  const label = labelOf(access.integration)

  const connections = yield* findConnections({ provider: access.integration }).pipe(
    Effect.catch((error) => refuse(messageOf(error))),
  )

  const usable = connections.filter((c) => c.status === 'connected')
  const connection = usable.find((c) => c.userId === prefer) ?? usable[0]

  if (!connection) {
    return yield* refuse(`Connect ${label} on the Integrations page first`)
  }

  return yield* getAccessToken(connection.id).pipe(
    Effect.catch((error) => refuse(messageOf(error))),
  )
})

/** Whether a network's access is in place, and what to do when it isn't. For the page: it shows no token and no account. */
export const accessProblem = Effect.fn('marketingNetworks.accessProblem')(function* (
  access: NetworkAccess | undefined,
) {
  if (!access) {
    return null
  }

  if ('env' in access) {
    return (yield* config.variable(access.env))
      ? null
      : `Set ${access.env} in the CRM's environment`
  }

  const label = labelOf(access.integration)

  if (!Object.hasOwn(providers(), access.integration)) {
    return `No integration "${access.integration}" in src/app/extensions.ts`
  }

  if (!(yield* providerReady(access.integration))) {
    return `${label} is not set up: its client id and secret are not in the environment`
  }

  const connections = yield* findConnections({ provider: access.integration })

  return connections.some((c) => c.status === 'connected')
    ? null
    : `Connect ${label} on the Integrations page`
})

/**
 * Channels and ad accounts the config says the CRM reaches itself, for a
 * network nothing here has code for. For start-up. One that goes through the
 * agent engine is not checked: only the engine knows which workflows it has.
 */
export function validateMarketing(): string[] {
  const marketing = crmConfig().marketing

  if (!marketing) {
    return []
  }

  return [
    ...Object.entries(marketing.channels)
      .filter(([, c]) => c.via === 'direct' && !postNetwork(c.network)?.publish)
      .map(
        ([key, c]) =>
          `marketing.channels.${key}: nothing here can post to "${c.network}"; add it under marketing in src/app/extensions.ts, or set "via": "swirls"`,
      ),
    ...Object.entries(marketing.ads)
      .filter(([, a]) => a.via === 'direct' && !adNetwork(a.network)?.read)
      .map(
        ([key, a]) =>
          `marketing.ads.${key}: nothing here can read "${a.network}"; add it under marketing in src/app/extensions.ts, or set "via": "swirls"`,
      ),
  ]
}
