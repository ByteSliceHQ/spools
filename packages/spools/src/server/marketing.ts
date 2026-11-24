import { Cause, Effect, type Fiber, Predicate, Schedule } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { z } from 'zod'

import type { CrmMarketing } from '../crm/config-schema'
import {
  checkPost,
  type Delivery,
  type DetectedTags,
  detectTags,
  isPostStatus,
  type PostStatus,
  POST_MAX,
  type PostSpec,
  postText,
  PUBLISH_ANSWER_MS,
  type SiteSummary,
  TAG_KINDS,
  withUtm,
} from '../crm/marketing'
import { accessProblem, accessToken, adNetwork, postNetwork } from './marketing-networks'
import { MarketingSource } from './marketing-source'
import { Agents } from './runtime/agents'
import { runtime } from './runtime/app'
import * as config from './runtime/config'
import { Invalid, messageOf, NotConfigured, NotFound } from './runtime/errors'
import { parseJson } from './runtime/json'
import { policies, withPolicy } from './runtime/policies'
import { asc, desc, lte, oneOf } from './store/query'
import { Store } from './store/store'
import { MarketingAd, MarketingPost, MarketingSite } from './store/tables'
import type { CrmUser } from './users'

/**
 * Marketing: what the CRM knows of the business's website, the posts it sends
 * to social channels, and the results of its ads. Set up under `marketing` in
 * crm.config.json; see docs/marketing.md.
 *
 * Each channel and ad account is reached one of two ways (marketing-networks.ts):
 * `direct`, where the CRM calls the network itself with a teammate's connected
 * account or a token from the environment, or `swirls`, where a workflow of
 * the agent engine does it (`publish_<network>`, `ads_<network>`) and answers
 * through the tool API (src/server/tools.ts). `site_profile`, which reads the
 * website, is always a workflow: it needs a model.
 *
 * A post goes out once. It is taken with one conditional update (`hold`), so
 * two ticks can't both send it, and it is never sent twice: when its fate is
 * unknown (the network or the engine did not answer), it is marked failed with
 * a note to look at the channel first, and a person decides whether to send it
 * again. Only a teammate can schedule or publish. The assistant can only draft.
 */

/** The workflows this module starts, by name. One per network, so a Spool deploys only the ones it uses. */
export const WORKFLOWS = {
  profile: 'site_profile',
  publish: (network: string) => `publish_${network}`,
  ads: (network: string) => `ads_${network}`,
} as const

/** How a channel or an ad account is reached: as the config says, else directly when the network can be. */
const deliveryOf = (via: Delivery | undefined, direct: boolean): Delivery =>
  via ?? (direct ? 'direct' : 'swirls')

/** What is known of a network's posts. One only a workflow knows has no limit of its own. */
const specOf = (network: string): PostSpec => {
  const def = postNetwork(network)

  return def
    ? { label: def.label, limit: def.limit, linkLength: def.linkLength }
    : { label: network, limit: POST_MAX }
}

/** What a post whose fate is unknown says. */
const LOOK_FIRST = 'It may still have gone out: look at the channel before publishing it again.'

/** The most of a page that is read for tags. They are in the head: this is far more than one. */
const PAGE_MAX = 2_000_000
/** Posts taken per query. A tick keeps going until nothing is due or its time is up. */
const BATCH = 10
/** Posts listed on the page. */
const LISTED = 200

type Post = NonNullable<typeof MarketingPost.row>

declare global {
  /** The schedule's fiber, on the global object so a dev-server reload doesn't start a second (see campaigns.ts). */
  var spoolsMarketingFiber: Fiber.Fiber<unknown, unknown> | undefined
}

/** The marketing block, or undefined when the config has none. */
export const current = Effect.fn('marketing.current')(function* () {
  return yield* (yield* MarketingSource).current
})

/** The marketing block, or why there is nothing to do. */
const settings = Effect.fn('marketing.settings')(function* () {
  const marketing = yield* current()

  if (!marketing) {
    return yield* new NotConfigured({
      feature: 'marketing',
      message: 'Marketing is not set up: add "marketing" to crm.config.json',
    })
  }

  return marketing
})

const detected = z.object(
  Object.fromEntries(TAG_KINDS.map((kind) => [kind, z.array(z.string()).default([])])),
)

const stringList = z.array(z.string())

/** The tags a stored scan found, or null when there is no scan to read. */
function tagsOf(stored: string | null | undefined): DetectedTags | null {
  const parsed = detected.safeParse(stored ? parseJson(stored) : undefined)

  if (!parsed.success) {
    return null
  }

  return {
    gtm: parsed.data['gtm'] ?? [],
    ga4: parsed.data['ga4'] ?? [],
    googleAds: parsed.data['googleAds'] ?? [],
    metaPixel: parsed.data['metaPixel'] ?? [],
    linkedinInsight: parsed.data['linkedinInsight'] ?? [],
  }
}

/** The row for the configured website, made the first time it is asked for. */
const siteRow = Effect.fn('marketing.siteRow')(function* (website: string) {
  const store = yield* Store
  const find = store.first(MarketingSite, { where: { website } })
  const existing = yield* find

  if (existing) {
    return existing
  }

  return yield* store.insert(MarketingSite, { website }).pipe(
    // Two requests at once: the unique index kept one row.
    Effect.catchTag('DatabaseError', (error) =>
      find.pipe(Effect.filterOrFail(Predicate.isNotNull, () => error)),
    ),
  )
})

/** What the page shows of the website: the last scan and what the engine learned. */
export const site = Effect.fn('marketing.site')(function* () {
  const { website } = yield* settings()
  const row = yield* siteRow(website)
  const offers = stringList.safeParse(row.offers ? parseJson(row.offers) : undefined)

  const profile: SiteSummary | null =
    row.summary === null || row.summary === undefined
      ? null
      : {
          summary: row.summary,
          audience: row.audience ?? '',
          voice: row.voice ?? '',
          offers: offers.success ? offers.data : [],
        }

  return {
    website,
    tags: tagsOf(row.tags),
    scannedAt: row.scannedAt ?? null,
    scanError: row.scanError ?? null,
    profile,
    profiledAt: row.profiledAt ?? null,
    profileRequestedAt: row.profileRequestedAt ?? null,
  }
})

/** The home page's source, or why it could not be read. Never fails: a site that is down is an answer. */
const readPage = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    const res = yield* client.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({ accept: 'text/html', 'user-agent': 'Spools-CRM tag check' }),
      ),
    )

    if (res.status >= 400) {
      return { error: `The site answered ${res.status}` }
    }

    const html = yield* res.text
    return { html: html.slice(0, PAGE_MAX) }
  }).pipe(
    withPolicy(policies.website),
    Effect.catch((error) =>
      Effect.succeed({
        error:
          error._tag === 'Timeout'
            ? 'The site did not answer in time'
            : 'The site could not be reached',
      }),
    ),
  )

/**
 * Read the website's home page and note which tracking tags it carries. The
 * address is the config's, so only whoever deploys the CRM chooses what is fetched.
 */
export const scanSite = Effect.fn('marketing.scanSite')(function* () {
  const { website } = yield* settings()
  const row = yield* siteRow(website)
  const page = yield* readPage(website)
  const store = yield* Store

  yield* store.update(
    MarketingSite,
    { where: { id: row.id } },
    'error' in page
      ? { scanError: page.error, scannedAt: new Date() }
      : { tags: JSON.stringify(detectTags(page.html)), scanError: null, scannedAt: new Date() },
  )

  return yield* site()
})

const actorOf = (user: CrmUser | null) =>
  user ? { id: user.id, email: user.email, name: user.name } : null

/** What a started run tells whoever pressed the button. */
const started = (run: { skipped: true; reason: string } | { skipped: false }, done: string) =>
  run.skipped
    ? { started: false, message: `Not started: ${run.reason}` }
    : { started: true, message: done }

/** Ask the agent engine to read the website and say what the business is. It answers through `save_site_profile`. */
export const profileSite = Effect.fn('marketing.profileSite')(function* (user: CrmUser) {
  const { website } = yield* settings()
  const row = yield* siteRow(website)

  const run = yield* (yield* Agents).executeWorkflow(WORKFLOWS.profile, {
    website,
    actor: actorOf(user),
    trigger: 'marketing.profile',
  })

  if (!run.skipped) {
    yield* (yield* Store).update(
      MarketingSite,
      { where: { id: row.id } },
      { profileRequestedAt: new Date() },
    )
  }

  return started(run, 'Reading the website. The profile appears here in a minute or two.')
})

/** What the engine may say of the website. Lengths are limits, not expectations. */
export const siteProfileInput = z.object({
  summary: z.string().trim().min(1).max(2000),
  audience: z.string().trim().max(1000).default(''),
  voice: z.string().trim().max(1000).default(''),
  offers: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
})

/** Keep what the engine learned from the website (the `save_site_profile` tool). */
export const saveSiteProfile = Effect.fn('marketing.saveSiteProfile')(function* (
  input: z.output<typeof siteProfileInput>,
) {
  const { website } = yield* settings()
  const row = yield* siteRow(website)

  yield* (yield* Store).update(
    MarketingSite,
    { where: { id: row.id } },
    {
      summary: input.summary,
      audience: input.audience,
      voice: input.voice,
      offers: JSON.stringify(input.offers),
      profiledAt: new Date(),
    },
  )

  return { saved: true }
})

/** A post as the page and the assistant see it. */
export type PostView = {
  id: string
  channel: string
  body: string
  link: string | null
  status: PostStatus
  scheduledAt: Date | null
  publishedAt: Date | null
  externalUrl: string | null
  note: string | null
  createdByName: string | null
  createdAt: Date
  /** It was handed to the engine long enough ago that an answer should have come. */
  overdue: boolean
}

const viewOf = (post: Post, now: Date): PostView => {
  const status = isPostStatus(post.status) ? post.status : 'failed'

  return {
    id: post.id,
    channel: post.channel,
    body: post.body,
    link: post.link ?? null,
    status,
    scheduledAt: post.scheduledAt ?? null,
    publishedAt: post.publishedAt ?? null,
    externalUrl: post.externalUrl ?? null,
    note: post.note ?? null,
    createdByName: post.createdByName ?? null,
    createdAt: post.createdAt,
    overdue:
      status === 'publishing' &&
      !!post.startedAt &&
      now.getTime() - post.startedAt.getTime() > PUBLISH_ANSWER_MS,
  }
}

export const listPosts = Effect.fn('marketing.listPosts')(function* () {
  const now = new Date()

  const posts = yield* (yield* Store).find(MarketingPost, {
    order: [desc('createdAt')],
    limit: LISTED,
  })

  return posts.map((post) => viewOf(post, now))
})

const channelOf = Effect.fn('marketing.channelOf')(function* (
  marketing: CrmMarketing,
  key: string,
) {
  const channel = Object.hasOwn(marketing.channels, key) ? marketing.channels[key] : undefined

  if (!channel) {
    return yield* new Invalid({ message: `No channel "${key}" under marketing.channels` })
  }

  return channel
})

/** What a draft is made of. */
export const draftInput = z.object({
  channel: z.string().min(1).max(60),
  body: z.string().trim().min(1).max(63_206),
  link: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullish(),
})

type Author = { id: string; name: string }

/** Write a draft. Checked against its network now, so what is wrong with it is said to whoever wrote it. */
export const draftPost = Effect.fn('marketing.draftPost')(function* (
  input: z.output<typeof draftInput>,
  author: Author,
) {
  const channel = yield* channelOf(yield* settings(), input.channel)
  const [problem] = checkPost(specOf(channel.network), input.body, input.link)

  if (problem) {
    return yield* new Invalid({ message: problem })
  }

  const post = yield* (yield* Store).insert(MarketingPost, {
    channel: input.channel,
    body: input.body,
    link: input.link ?? null,
    status: 'draft',
    createdBy: author.id,
    createdByName: author.name,
  })

  return viewOf(post, new Date())
})

/** Statuses a post can still be edited, scheduled or deleted in: nothing has been handed to the engine. */
const HELD = ['draft', 'scheduled', 'failed'] as const

const mine = (id: string, statuses: readonly PostStatus[]) => ({
  where: { id },
  filter: oneOf('status', statuses),
})

const gone = (id: string) =>
  Effect.gen(function* () {
    const post = yield* (yield* Store).first(MarketingPost, { where: { id } })

    if (!post) {
      return yield* new NotFound({ what: 'Post' })
    }

    return yield* new Invalid({
      message:
        post.status === 'published'
          ? 'This post has already gone out'
          : 'This post is being published. Wait for the answer',
    })
  })

/** Change a post that has not gone out. It goes back to being a draft: a changed post needs approving again. */
export const editPost = Effect.fn('marketing.editPost')(function* (
  id: string,
  input: z.output<typeof draftInput>,
) {
  const channel = yield* channelOf(yield* settings(), input.channel)
  const [problem] = checkPost(specOf(channel.network), input.body, input.link)

  if (problem) {
    return yield* new Invalid({ message: problem })
  }

  const changed = yield* (yield* Store).update(MarketingPost, mine(id, HELD), {
    channel: input.channel,
    body: input.body,
    link: input.link ?? null,
    status: 'draft',
    scheduledAt: null,
    approvedBy: null,
    note: null,
  })

  if (changed === 0) {
    return yield* gone(id)
  }

  return { saved: true }
})

/** Set the time a post goes out. The teammate who does is the one who approved it. */
export const schedulePost = Effect.fn('marketing.schedulePost')(function* (
  id: string,
  when: Date,
  user: CrmUser,
) {
  if (when.getTime() < Date.now() - 60_000) {
    return yield* new Invalid({ message: 'Choose a time that has not passed' })
  }

  const changed = yield* (yield* Store).update(MarketingPost, mine(id, HELD), {
    status: 'scheduled',
    scheduledAt: when,
    approvedBy: user.id,
    note: null,
  })

  if (changed === 0) {
    return yield* gone(id)
  }

  return { scheduled: true }
})

/** Take a scheduled post back to a draft. */
export const unschedulePost = Effect.fn('marketing.unschedulePost')(function* (id: string) {
  const changed = yield* (yield* Store).update(MarketingPost, mine(id, ['scheduled']), {
    status: 'draft',
    scheduledAt: null,
    approvedBy: null,
  })

  return { unscheduled: changed > 0 }
})

export const deletePost = Effect.fn('marketing.deletePost')(function* (id: string) {
  const removed = yield* (yield* Store).remove(MarketingPost, mine(id, HELD))

  if (removed === 0) {
    return yield* gone(id)
  }

  return { deleted: true }
})

const change = (id: string, changes: Partial<NonNullable<typeof MarketingPost.insert>>) =>
  Store.use((store) =>
    store.update(MarketingPost, { where: { id, status: 'publishing' } }, changes),
  )

/**
 * Send a post that is already held (`publishing`), the way its channel is
 * reached. Whatever happens, the post is left saying so. A post whose fate is
 * unknown is a failure with a warning, never a second send.
 */
const send = Effect.fn('marketing.send')(function* (post: Post, user: CrmUser | null) {
  const marketing = yield* settings()

  const channel = Object.hasOwn(marketing.channels, post.channel)
    ? marketing.channels[post.channel]
    : undefined

  if (!channel) {
    yield* change(post.id, {
      status: 'failed',
      note: `The channel "${post.channel}" is no longer in crm.config.json`,
    })

    return 'failed' as const
  }

  const link = post.link
    ? withUtm(post.link, { source: channel.network, medium: 'social', campaign: post.channel })
    : null

  const text = postText(post.body, link)
  const network = postNetwork(channel.network)

  if (deliveryOf(channel.via, !!network?.publish) === 'direct') {
    const publish = network?.publish

    if (!publish) {
      yield* change(post.id, {
        status: 'failed',
        note: `Nothing here can post to "${channel.network}". Add it under marketing in src/app/extensions.ts, or set "via": "swirls" on the channel.`,
      })

      return 'failed' as const
    }

    const outcome = yield* accessToken(network.access, post.approvedBy).pipe(
      Effect.flatMap((token) =>
        publish({ text, body: post.body, link, account: channel.account, token }),
      ),
      Effect.map((published) => ({ published })),
      Effect.catchTag('NetworkFailure', (failure) => Effect.succeed({ failure })),
    )

    if ('failure' in outcome) {
      const { message, uncertain } = outcome.failure

      yield* change(post.id, {
        status: 'failed',
        note: uncertain ? `${message}. ${LOOK_FIRST}` : message,
      })

      return 'failed' as const
    }

    const { id, url } = outcome.published

    yield* change(post.id, {
      status: 'published',
      publishedAt: new Date(),
      externalId: id,
      externalUrl: url?.startsWith('https://') ? url : null,
      note: null,
    })

    return 'published' as const
  }

  const run = yield* (yield* Agents)
    .executeWorkflow(WORKFLOWS.publish(channel.network), {
      post: { id: post.id, text, body: post.body, link },
      channel: { key: post.channel, network: channel.network, account: channel.account },
      actor: actorOf(user),
      trigger: 'marketing.publish',
    })
    .pipe(
      Effect.catch((error) =>
        Effect.succeed({ unconfirmed: `${messageOf(error)}. ${LOOK_FIRST}` }),
      ),
    )

  if ('unconfirmed' in run) {
    yield* change(post.id, { status: 'failed', note: run.unconfirmed })
    return 'failed' as const
  }

  if (run.skipped) {
    yield* change(post.id, { status: 'failed', note: `Not sent: ${run.reason}` })
    return 'failed' as const
  }

  yield* change(post.id, { executionId: run.executionId })
  return 'sent' as const
})

/** Take a post for publishing: of two callers, one gets it. */
const hold = (id: string, from: readonly PostStatus[], now: Date, approvedBy?: string) =>
  Effect.gen(function* () {
    const store = yield* Store

    const changes: Partial<NonNullable<typeof MarketingPost.insert>> = {
      status: 'publishing',
      startedAt: now,
      note: null,
      executionId: null,
    }

    // A scheduled post keeps whoever scheduled it.
    if (approvedBy) {
      changes.approvedBy = approvedBy
    }

    const took = yield* store.update(MarketingPost, mine(id, from), changes)

    return took === 0 ? null : yield* store.first(MarketingPost, { where: { id } })
  })

/** Publish a post now. The teammate who presses the button is the one who approved it. */
export const publishPost = Effect.fn('marketing.publishPost')(function* (
  id: string,
  user: CrmUser,
) {
  const held = yield* hold(id, HELD, new Date(), user.id)

  if (!held) {
    return yield* gone(id)
  }

  const outcome = yield* send(held, user)

  if (outcome === 'published') {
    return { sent: true, message: 'Published.' }
  }

  return outcome === 'sent'
    ? { sent: true, message: 'Publishing. It shows as published when the network confirms it.' }
    : { sent: false, message: 'It could not be sent. The post says why.' }
})

/** What the engine says of a post it was asked to publish. */
export const postResultInput = z.object({
  postId: z.string().uuid(),
  ok: z.boolean(),
  externalId: z.string().max(300).nullish(),
  url: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullish(),
  error: z.string().max(2000).nullish(),
})

/**
 * Record how publishing went (the `post_result` tool). Only a post that is
 * waiting for an answer takes one, so an answer sent twice changes nothing.
 */
export const postResult = Effect.fn('marketing.postResult')(function* (
  input: z.output<typeof postResultInput>,
) {
  const changed = yield* change(
    input.postId,
    input.ok
      ? {
          status: 'published',
          publishedAt: new Date(),
          externalId: input.externalId ?? null,
          externalUrl: input.url ?? null,
          note: null,
        }
      : { status: 'failed', note: input.error?.trim() || 'The network refused the post' },
  )

  return { recorded: changed > 0 }
})

/**
 * A teammate says a post that never got its answer did not go out, so it can
 * be sent again. Only offered once the answer is overdue.
 */
export const releasePost = Effect.fn('marketing.releasePost')(function* (id: string) {
  const store = yield* Store
  const post = yield* store.first(MarketingPost, { where: { id } })

  if (!post) {
    return yield* new NotFound({ what: 'Post' })
  }

  if (!viewOf(post, new Date()).overdue) {
    return yield* new Invalid({ message: 'This post is still waiting for its answer' })
  }

  yield* change(id, {
    status: 'failed',
    note: 'No answer came back. Look at the channel before publishing it again.',
  })

  return { released: true }
})

export type TickResult = {
  sent: number
  failed: number
  /** Time ran out with posts still due: the next tick carries on. */
  more: boolean
}

/**
 * Publish every scheduled post that is due. Safe to call from several places
 * at once. Nobody is signed in here, so the engine needs a credential of its
 * own (SWIRLS_API_KEY); without one a due post fails and says so.
 */
export const tick = Effect.fn('marketing.tick')(function* (
  opts: { now?: Date; budgetMs?: number } = {},
) {
  const began = Date.now()
  const result: TickResult = { sent: 0, failed: 0, more: false }

  if (Object.keys((yield* current())?.channels ?? {}).length === 0) {
    return result
  }

  const store = yield* Store

  for (;;) {
    const now = opts.now ?? new Date()

    const due = yield* store.find(MarketingPost, {
      where: { status: 'scheduled' },
      filter: lte('scheduledAt', now),
      order: [asc('scheduledAt')],
      limit: BATCH,
    })

    if (due.length === 0) {
      return result
    }

    let took = 0

    for (const post of due) {
      if (opts.budgetMs !== undefined && Date.now() - began > opts.budgetMs) {
        result.more = true
        return result
      }

      const held = yield* hold(post.id, ['scheduled'], now)

      if (!held) {
        continue
      }

      took++
      result[(yield* send(held, null)) === 'failed' ? 'failed' : 'sent']++
    }

    // Every post in the batch went to another tick: it is dealing with them.
    if (took === 0) {
      return result
    }
  }
})

/** The built-in schedule: a tick now, for what fell due while the server was down, then once a minute. */
export const marketingSchedule = tick({ budgetMs: 50_000 }).pipe(
  Effect.catchCause((cause) => Effect.logError('[marketing] tick failed', Cause.pretty(cause))),
  Effect.repeat(Schedule.spaced('1 minute')),
)

/**
 * Start publishing scheduled posts as they fall due. Called once when the
 * server boots. On a serverless host a cron job calls /api/cron/marketing instead.
 */
export const startMarketing = Effect.fn('marketing.startMarketing')(function* () {
  if (yield* config.flag('SERVERLESS')) {
    return
  }

  if (Object.keys((yield* current())?.channels ?? {}).length === 0) {
    return
  }

  if (globalThis.spoolsMarketingFiber) {
    return
  }

  globalThis.spoolsMarketingFiber = runtime().runFork(marketingSchedule)
})

/** One ad account read, or asked for: what to tell whoever pressed the button. */
type AdsOutcome = { ok: boolean; said: string }

/** Read one ad account the way it is reached. Never fails: an account that can't be read says why. */
const syncAccount = Effect.fn('marketing.syncAccount')(function* (
  key: string,
  account: CrmMarketing['ads'][string],
  user: CrmUser | null,
) {
  const network = adNetwork(account.network)

  const answer = (ok: boolean, said: string): AdsOutcome => ({
    ok,
    said: `${account.label}: ${said}`,
  })

  if (deliveryOf(account.via, !!network?.read) === 'direct') {
    const read = network?.read

    if (!read) {
      return answer(false, `nothing here can read "${account.network}"`)
    }

    const outcome = yield* accessToken(network.access, user?.id).pipe(
      Effect.flatMap((token) => read({ account: account.account, token, days: ADS_DAYS })),
      Effect.map((campaigns) => ({ campaigns })),
      Effect.catchTag('NetworkFailure', (failure) => Effect.succeed({ failure })),
    )

    if ('failure' in outcome) {
      return answer(false, outcome.failure.message)
    }

    const input = adsInput.safeParse({
      account: key,
      periodDays: ADS_DAYS,
      campaigns: outcome.campaigns.slice(0, ADS_MAX),
    })

    if (!input.success) {
      return answer(false, 'its results were not in a form the CRM can keep')
    }

    const { saved } = yield* saveAds(input.data)
    return answer(true, `read ${saved} ${saved === 1 ? 'campaign' : 'campaigns'}`)
  }

  const run = yield* (yield* Agents)
    .executeWorkflow(WORKFLOWS.ads(account.network), {
      account: { key, network: account.network, account: account.account },
      actor: actorOf(user),
      trigger: 'marketing.ads',
    })
    .pipe(Effect.catch((error) => Effect.succeed({ failed: messageOf(error) })))

  if ('failed' in run) {
    return answer(false, run.failed)
  }

  return run.skipped
    ? answer(false, `not started: ${run.reason}`)
    : answer(true, 'being read. Results appear in a minute or two')
})

/** Read every configured ad account, each on its own, so one account's failure leaves the others. */
export const syncAds = Effect.fn('marketing.syncAds')(function* (user: CrmUser | null) {
  const { ads } = yield* settings()

  if (Object.keys(ads).length === 0) {
    return { started: false, message: 'No ad accounts under marketing.ads in crm.config.json' }
  }

  const outcomes = yield* Effect.forEach(Object.entries(ads), ([key, account]) =>
    syncAccount(key, account, user),
  )

  return {
    started: outcomes.some((outcome) => outcome.ok),
    message: `${outcomes.map((outcome) => outcome.said).join('. ')}.`,
  }
})

/**
 * How each channel and ad account is reached, and what stands in the way, for
 * the page. No token and no account's name is in it.
 */
export const reach = Effect.fn('marketing.reach')(function* () {
  const marketing = yield* settings()
  const engine = yield* (yield* Agents).configured
  const noEngine = 'The agent engine is not set up (SWIRLS_PROJECT_ID)'

  const channels = yield* Effect.forEach(Object.entries(marketing.channels), ([key, channel]) =>
    Effect.gen(function* () {
      const network = postNetwork(channel.network)
      const delivery = deliveryOf(channel.via, !!network?.publish)
      const spec = specOf(channel.network)

      const problem =
        delivery === 'swirls'
          ? engine
            ? null
            : noEngine
          : network?.publish
            ? yield* accessProblem(network.access)
            : `Nothing here can post to "${channel.network}"`

      return {
        key,
        label: channel.label,
        network: spec.label,
        limit: spec.limit,
        linkLength: spec.linkLength ?? null,
        delivery,
        problem,
      }
    }),
  )

  const ads = yield* Effect.forEach(Object.entries(marketing.ads), ([key, account]) =>
    Effect.gen(function* () {
      const network = adNetwork(account.network)
      const delivery = deliveryOf(account.via, !!network?.read)

      const problem =
        delivery === 'swirls'
          ? engine
            ? null
            : noEngine
          : network?.read
            ? yield* accessProblem(network.access)
            : `Nothing here can read "${account.network}"`

      return {
        key,
        label: account.label,
        network: network?.label ?? account.network,
        delivery,
        problem,
      }
    }),
  )

  return { channels, ads }
})

/** How many days of ad results are read, and the most campaigns kept for one account. */
const ADS_DAYS = 30
const ADS_MAX = 500

const count = z.coerce.number().int().min(0).max(1e12).default(0)
const amount = z.coerce.number().min(0).max(1e12)

/** One account's campaigns, as the engine read them. Numbers may arrive as text: ad APIs send both. */
export const adsInput = z.object({
  account: z.string().min(1).max(60),
  periodDays: z.number().int().min(1).max(365).default(30),
  campaigns: z
    .array(
      z.object({
        externalId: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(300),
        status: z.string().trim().min(1).max(40),
        currency: z.string().trim().max(8).nullish(),
        spend: amount.default(0),
        impressions: count,
        clicks: count,
        conversions: amount.default(0),
        dailyBudget: amount.nullish(),
      }),
    )
    .max(500),
})

/**
 * Replace what the CRM holds of one ad account with what the engine just read
 * (the `save_ads` tool). Campaigns the network no longer lists are dropped.
 */
export const saveAds = Effect.fn('marketing.saveAds')(function* (input: z.output<typeof adsInput>) {
  const { ads } = yield* settings()

  if (!Object.hasOwn(ads, input.account)) {
    return yield* new Invalid({ message: `No ad account "${input.account}" under marketing.ads` })
  }

  const store = yield* Store
  const syncedAt = new Date()
  const existing = yield* store.find(MarketingAd, { where: { account: input.account } })
  const known = new Map(existing.map((row) => [row.externalId, row.id]))

  for (const campaign of input.campaigns) {
    const values = {
      name: campaign.name,
      status: campaign.status.toLowerCase(),
      currency: campaign.currency ?? null,
      spend: campaign.spend,
      impressions: campaign.impressions,
      clicks: campaign.clicks,
      conversions: campaign.conversions,
      dailyBudget: campaign.dailyBudget ?? null,
      periodDays: input.periodDays,
      syncedAt,
    }

    const id = known.get(campaign.externalId)
    known.delete(campaign.externalId)

    if (id) {
      yield* store.update(MarketingAd, { where: { id } }, values)
    } else {
      yield* store.insert(MarketingAd, {
        account: input.account,
        externalId: campaign.externalId,
        ...values,
      })
    }
  }

  for (const id of known.values()) {
    yield* store.remove(MarketingAd, { where: { id } })
  }

  return { saved: input.campaigns.length, removed: known.size }
})

export const listAds = Effect.fn('marketing.listAds')(function* () {
  return yield* (yield* Store).find(MarketingAd, {
    order: [asc('account'), desc('spend')],
    limit: 1000,
  })
})
