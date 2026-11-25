import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'

import { Effect, Layer } from 'effect'

import extensions from '../../../../apps/starter/src/app/extensions'
import type { CrmMarketing } from '../../src/crm/config-schema'
import { completeAuth, createAuthRequest } from '../../src/server/integrations'
import * as marketing from '../../src/server/marketing'
import { providersFor } from '../../src/server/marketing-providers'
import { MarketingSource } from '../../src/server/marketing-source'
import { Agents } from '../../src/server/runtime/agents'
import { AgentsError } from '../../src/server/runtime/errors'
import { Vault } from '../../src/server/runtime/vault'
import {
  Integration,
  MarketingAd,
  MarketingPost,
  MarketingSite,
} from '../../src/server/store/tables'
import { runTool } from '../../src/server/tools'
import { bodyText, db, failure, installLiveServices, installStandIns, run } from '../support/run'

// Marketing against a real database. Channels are reached both ways: through
// a stand-in agent engine (what it was asked to start is recorded; its answers
// are sent through the tool API, as a workflow's are), and directly, with one
// stand-in `fetch` playing the business's website and every network's API.

const tag = `mkt${Date.now()}`
const website = `https://${tag}.example.com`

const settings: CrmMarketing = {
  website,
  tags: { ga4: 'G-ABCDE12345' },
  channels: {
    // Through the engine, because the channel says so.
    page: {
      label: 'Company page',
      network: 'linkedin',
      account: 'urn:li:organization:1',
      via: 'swirls',
    },
    feed: { label: 'X', network: 'x', account: 'acme', via: 'swirls' },
    // Directly: a token from the environment, a teammate's connection, the app's own network.
    fb: { label: 'Facebook page', network: 'facebook', account: '1000' },
    me: { label: 'My LinkedIn', network: 'linkedin', account: 'urn:li:person:abc' },
    toot: { label: 'Mastodon', network: 'mastodon', account: 'acme' },
    // A network nothing here knows: only a workflow can reach it.
    sky: { label: 'Bluesky', network: 'bluesky', account: 'acme' },
  },
  ads: {
    meta: { label: 'Meta', network: 'meta', account: '123456' },
    search: { label: 'Search', network: 'google', account: '1234567890', via: 'swirls' },
  },
}

const staff = { id: `user_${tag}`, email: 'ana@example.com', name: 'Ana' }

type Started = { name: string; input: Record<string, unknown> }
const started: Started[] = []
/** What the engine does when asked to start a run. */
let engine: 'starts' | 'skips' | 'fails' = 'starts'
let html = ''
let siteStatus = 200
/** How Facebook answers a post to a page. */
let facebook: 'ok' | 'refused' | 'broken' = 'ok'
const calls: { url: string; method: string; body: string; authorization: string | null }[] = []
const tooted: string[] = []
const saved = { integrations: extensions.integrations, marketing: extensions.marketing }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The website and every network, by address. */
const outside = async (url: string, init?: RequestInit) => {
  calls.push({
    url,
    method: init?.method ?? 'GET',
    body: bodyText(init),
    authorization: new Headers(init?.headers).get('authorization'),
  })

  if (url.startsWith(website)) {
    return new Response(html, { status: siteStatus })
  }

  if (url.includes('fields=access_token')) {
    return json({ access_token: 'page-token', id: '1000' })
  }

  if (url.endsWith('/1000/feed')) {
    if (facebook === 'refused') {
      return json({ error: { message: '(#200) The page has not granted this permission' } }, 403)
    }

    return facebook === 'broken' ? json({}, 502) : json({ id: '1000_2000' })
  }

  if (url.includes('/act_123456/campaigns')) {
    return json({
      data: [
        { id: 'c1', name: 'Spring', effective_status: 'ACTIVE', daily_budget: '5000' },
        { id: 'c2', name: 'Paused one', effective_status: 'PAUSED' },
      ],
    })
  }

  if (url.includes('/act_123456/insights')) {
    return json({
      data: [
        {
          campaign_id: 'c1',
          spend: '120.50',
          impressions: '1000',
          clicks: '40',
          account_currency: 'USD',
          actions: [
            { action_type: 'link_click', value: '40' },
            { action_type: 'lead', value: '4' },
          ],
        },
      ],
    })
  }

  // LinkedIn gives most apps an access token and nothing to renew it with.
  if (url.endsWith('/accessToken')) {
    return json({ access_token: 'linkedin-access', expires_in: 5_184_000 })
  }

  if (url.endsWith('/userinfo')) {
    return json({ email: 'ana@example.com', sub: 'abc' })
  }

  if (url.endsWith('/v2/ugcPosts')) {
    return json({ id: 'urn:li:share:77' }, 201)
  }

  return json({}, 404)
}

const agents = Layer.succeed(
  Agents,
  Agents.of({
    configured: Effect.succeed(true),
    chat: Effect.succeed(null),
    executeWorkflow: (name, input) => {
      if (engine === 'fails') {
        return Effect.fail(new AgentsError({ message: 'Swirls did not answer in time' }))
      }

      if (engine === 'skips') {
        return Effect.succeed({ skipped: true, reason: 'nobody is signed in' })
      }

      started.push({ name, input })
      return Effect.succeed({ skipped: false, executionId: `run_${started.length}` })
    },
  }),
)

const variables = ['META_ACCESS_TOKEN', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']

beforeAll(async () => {
  process.env['APP_URL'] = 'https://crm.example.com'
  process.env['APP_SECRET'] = 's'.repeat(40)
  process.env['META_ACCESS_TOKEN'] = 'business-token'
  process.env['LINKEDIN_CLIENT_ID'] = 'linkedin-client'
  process.env['LINKEDIN_CLIENT_SECRET'] = 'linkedin-secret'

  // The built-in LinkedIn account, offered here as it is to a Spool whose config has a LinkedIn channel.
  extensions.integrations = { ...saved.integrations, ...providersFor(settings) }

  // A network the app adds: its own limit, its own token, its own code.
  extensions.marketing = {
    posts: {
      mastodon: {
        label: 'Mastodon',
        limit: 500,
        publish: async (post) => {
          if (post.body.includes('boom')) {
            throw new Error('The instance is closed')
          }

          tooted.push(post.text)
          return {
            id: `toot_${tooted.length}`,
            url: `https://mastodon.example/@acme/${tooted.length}`,
          }
        },
      },
    },
  }

  await installStandIns({
    agents,
    marketing: MarketingSource.layerTest(() => settings),
    fetch: outside,
    vault: Vault.layerTest({
      encrypt: async (plaintext) =>
        JSON.stringify({ c: Buffer.from(plaintext).toString('base64') }),
      decrypt: async (ciphertext) => Buffer.from(JSON.parse(ciphertext).c, 'base64').toString(),
    }),
  })
})

beforeEach(() => {
  started.length = 0
  calls.length = 0
  tooted.length = 0
  engine = 'starts'
  siteStatus = 200
  facebook = 'ok'
  process.env['META_ACCESS_TOKEN'] = 'business-token'
})

afterAll(async () => {
  await db.remove(MarketingPost, { where: { createdBy: staff.id } })
  await db.remove(MarketingAd, { where: { account: 'meta' } })
  await db.remove(MarketingAd, { where: { account: 'search' } })
  await db.remove(MarketingSite, { where: { website } })
  await db.remove(Integration, { where: { userId: staff.id } })
  await installLiveServices()

  for (const name of variables) {
    delete process.env[name]
  }

  if (saved.integrations === undefined) {
    delete extensions.integrations
  } else {
    extensions.integrations = saved.integrations
  }

  if (saved.marketing === undefined) {
    delete extensions.marketing
  } else {
    extensions.marketing = saved.marketing
  }
})

const wrote = (part: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(part))

const draft = async (channel = 'page', body = `Hello ${tag}`) =>
  run(marketing.draftPost({ channel, body, link: null }, { id: staff.id, name: staff.name }))

const post = (id: string) => db.first(MarketingPost, { where: { id } })

test('a scan records the tags the site carries', async () => {
  html = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDE12345"></script>`
  const site = await run(marketing.scanSite())
  expect(site.tags?.ga4).toEqual(['G-ABCDE12345'])
  expect(site.scanError).toBeNull()
  expect(site.scannedAt).toBeInstanceOf(Date)
})

test('a site that is down keeps the last scan and says why', async () => {
  siteStatus = 503
  const site = await run(marketing.scanSite())
  expect(site.scanError).toBe('The site answered 503')
  expect(site.tags?.ga4).toEqual(['G-ABCDE12345'])
})

test('the website profile is asked of the engine and kept when it answers', async () => {
  const asked = await run(marketing.profileSite(staff))
  expect(asked.started).toBe(true)
  expect(started).toHaveLength(1)
  expect(started[0]?.name).toBe('site_profile')
  expect(started[0]?.input['website']).toBe(website)

  const answer = await run(
    runTool('save_site_profile', {
      summary: 'Acme sells anvils.',
      audience: 'Coyotes',
      voice: 'Dry',
      offers: ['Anvils', 'Rockets'],
    }),
  )

  expect(answer.ok).toBe(true)
  const site = await run(marketing.site())

  expect(site.profile).toEqual({
    summary: 'Acme sells anvils.',
    audience: 'Coyotes',
    voice: 'Dry',
    offers: ['Anvils', 'Rockets'],
  })
})

test('a draft is checked against its network when it is written', async () => {
  const error = await failure(
    marketing.draftPost({ channel: 'feed', body: 'a'.repeat(300), link: null }, staff),
  )

  expect(error.message).toBe('X takes 280 characters and this is 300')

  const unknown = await failure(
    marketing.draftPost({ channel: 'nope', body: 'Hi', link: null }, staff),
  )

  expect(unknown.message).toContain('No channel "nope"')
})

test('publishing starts one run for the network and waits for its answer', async () => {
  const { id } = await draft()
  const result = await run(marketing.publishPost(id, staff))
  expect(result.sent).toBe(true)
  expect(started.map((s) => s.name)).toEqual(['publish_linkedin'])

  expect(started[0]?.input).toMatchObject({
    post: { id, text: `Hello ${tag}` },
    channel: { key: 'page', network: 'linkedin', account: 'urn:li:organization:1' },
  })

  expect(await post(id)).toMatchObject({
    status: 'publishing',
    approvedBy: staff.id,
    executionId: 'run_1',
  })

  const answer = await run(
    runTool('post_result', {
      postId: id,
      ok: true,
      externalId: 'urn:li:share:9',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:9',
    }),
  )

  expect(answer).toMatchObject({ ok: true, data: { recorded: true } })
  expect(await post(id)).toMatchObject({ status: 'published', externalId: 'urn:li:share:9' })
})

test('two people publishing the same post at once start one run', async () => {
  const { id } = await draft()

  const results = await Promise.allSettled([
    run(marketing.publishPost(id, staff)),
    run(marketing.publishPost(id, staff)),
  ])

  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(started).toHaveLength(1)
})

test('a published post is not published, edited or deleted again', async () => {
  const { id } = await draft()
  await run(marketing.publishPost(id, staff))
  await run(runTool('post_result', { postId: id, ok: true }))

  expect((await failure(marketing.publishPost(id, staff))).message).toBe(
    'This post has already gone out',
  )

  expect((await failure(marketing.deletePost(id))).message).toBe('This post has already gone out')
  expect(started).toHaveLength(1)
})

test('an answer sent twice changes nothing the second time', async () => {
  const { id } = await draft()
  await run(marketing.publishPost(id, staff))
  await run(runTool('post_result', { postId: id, ok: true, externalId: 'first' }))
  const again = await run(runTool('post_result', { postId: id, ok: false, error: 'late' }))
  expect(again).toMatchObject({ ok: true, data: { recorded: false } })
  expect(await post(id)).toMatchObject({ status: 'published', externalId: 'first' })
})

test("the network's refusal is kept on the post, which can then be sent again", async () => {
  const { id } = await draft()
  await run(marketing.publishPost(id, staff))
  await run(runTool('post_result', { postId: id, ok: false, error: 'LinkedIn answered 401' }))
  expect(await post(id)).toMatchObject({ status: 'failed', note: 'LinkedIn answered 401' })

  await run(marketing.publishPost(id, staff))
  expect(started).toHaveLength(2)
})

test('a start the engine did not confirm is a failure with a warning, never a second start', async () => {
  const { id } = await draft()
  engine = 'fails'
  const result = await run(marketing.publishPost(id, staff))
  expect(result.sent).toBe(false)
  const kept = await post(id)
  expect(kept?.status).toBe('failed')
  expect(kept?.note).toContain('look at the channel before publishing it again')
})

test('a scheduled post goes out when it is due, once', async () => {
  const { id } = await draft()
  const when = new Date(Date.now() + 3_600_000)
  await run(marketing.schedulePost(id, when, staff))

  expect(await run(marketing.tick())).toMatchObject({ sent: 0 })
  expect(started).toHaveLength(0)

  const later = new Date(when.getTime() + 1000)

  const [a, b] = await Promise.all([
    run(marketing.tick({ now: later })),
    run(marketing.tick({ now: later })),
  ])

  expect(a.sent + b.sent).toBe(1)
  expect(started.filter((s) => s.input['post'] && s.name === 'publish_linkedin')).toHaveLength(1)
  expect(await post(id)).toMatchObject({ status: 'publishing', approvedBy: staff.id })
})

test('a due post fails, and says why, when the engine has nobody to run as', async () => {
  const { id } = await draft()
  const when = new Date(Date.now() + 60_000)
  await run(marketing.schedulePost(id, when, staff))
  engine = 'skips'

  expect(await run(marketing.tick({ now: new Date(when.getTime() + 1000) }))).toMatchObject({
    failed: 1,
  })

  expect(await post(id)).toMatchObject({ status: 'failed', note: 'Not sent: nobody is signed in' })
})

test('editing a scheduled post takes it back to a draft', async () => {
  const { id } = await draft()
  await run(marketing.schedulePost(id, new Date(Date.now() + 60_000), staff))
  await run(marketing.editPost(id, { channel: 'page', body: 'Changed', link: null }))

  expect(await post(id)).toMatchObject({
    status: 'draft',
    body: 'Changed',
    scheduledAt: null,
    approvedBy: null,
  })
})

test('a time that has passed is not a time to schedule for', async () => {
  const { id } = await draft()
  const error = await failure(marketing.schedulePost(id, new Date(Date.now() - 3_600_000), staff))
  expect(error.message).toBe('Choose a time that has not passed')
})

test('the assistant can draft a post and nothing more', async () => {
  const drafted = await run(
    runTool('draft_post', { channel: 'page', body: `From the assistant ${tag}` }),
  )

  expect(drafted.ok).toBe(true)
  expect(started).toHaveLength(0)

  const [kept] = await db.find(MarketingPost, { where: { createdBy: 'swirls-agent' } })
  expect(kept?.status).toBe('draft')
  await db.remove(MarketingPost, { where: { createdBy: 'swirls-agent' } })

  for (const name of ['publish_post', 'schedule_post', 'publishPost']) {
    expect(await run(runTool(name, {}))).toMatchObject({ ok: false })
  }
})

test('an ad account reached through the engine is asked for, and its results replace what was held', async () => {
  const asked = await run(marketing.syncAds(staff))
  expect(asked.started).toBe(true)
  expect(started.map((s) => s.name)).toEqual(['ads_google'])
  expect(asked.message).toContain('Search: being read')

  const campaign = {
    externalId: 'c1',
    name: 'Spring',
    status: 'ACTIVE',
    currency: 'USD',
    spend: '120.50',
    impressions: '1000',
    clicks: 40,
    conversions: 4,
  }

  await run(
    runTool('save_ads', {
      account: 'search',
      campaigns: [campaign, { ...campaign, externalId: 'c2', name: 'Summer' }],
    }),
  )

  await run(runTool('save_ads', { account: 'search', campaigns: [{ ...campaign, spend: 200 }] }))

  const ads = (await run(marketing.listAds())).filter((ad) => ad.account === 'search')
  expect(ads).toHaveLength(1)

  expect(ads[0]).toMatchObject({
    externalId: 'c1',
    status: 'active',
    spend: 200,
    impressions: 1000,
    clicks: 40,
  })

  const refused = await run(runTool('save_ads', { account: 'someone-elses', campaigns: [] }))
  expect(refused).toMatchObject({ ok: false })
})

test('an ad account reached directly is read and kept in the same request', async () => {
  const asked = await run(marketing.syncAds(staff))
  expect(asked.message).toContain('Meta: read 2 campaigns')

  expect(
    calls
      .filter((c) => c.url.includes('act_123456'))
      .every((c) => c.authorization === 'Bearer business-token'),
  ).toBe(true)

  const ads = (await run(marketing.listAds())).filter((ad) => ad.account === 'meta')
  expect(ads.map((ad) => ad.externalId).sort()).toEqual(['c1', 'c2'])

  expect(ads.find((ad) => ad.externalId === 'c1')).toMatchObject({
    name: 'Spring',
    status: 'active',
    currency: 'USD',
    spend: 120.5,
    impressions: 1000,
    clicks: 40,
    // A result is a lead, not a click.
    conversions: 4,
    // Meta counts budgets in cents.
    dailyBudget: 50,
  })

  expect(ads.find((ad) => ad.externalId === 'c2')).toMatchObject({ status: 'paused', spend: 0 })
})

test('an ad account whose token is missing says what to set, and the others are still read', async () => {
  delete process.env['META_ACCESS_TOKEN']
  const asked = await run(marketing.syncAds(staff))
  expect(asked.message).toContain("Meta: Set META_ACCESS_TOKEN in the CRM's environment")
  expect(asked.message).toContain('Search: being read')
  expect(asked.started).toBe(true)
})

test('a post to a channel reached directly is published in the same request, as the page', async () => {
  const { id } = await draft('fb', `Open day ${tag}`)
  const result = await run(marketing.publishPost(id, staff))
  expect(result).toEqual({ sent: true, message: 'Published.' })
  expect(started).toHaveLength(0)

  const [sent] = wrote('/1000/feed')
  expect(sent?.authorization).toBe('Bearer page-token')
  expect(JSON.parse(sent?.body ?? '{}')).toEqual({ message: `Open day ${tag}` })

  expect(await post(id)).toMatchObject({
    status: 'published',
    externalId: '1000_2000',
    externalUrl: 'https://www.facebook.com/1000_2000',
    approvedBy: staff.id,
  })
})

test("a network's refusal is kept in its own words, and the post can be sent again", async () => {
  const { id } = await draft('fb')
  facebook = 'refused'
  expect((await run(marketing.publishPost(id, staff))).sent).toBe(false)

  expect(await post(id)).toMatchObject({
    status: 'failed',
    note: 'Facebook answered 403: (#200) The page has not granted this permission',
  })

  facebook = 'ok'
  expect((await run(marketing.publishPost(id, staff))).sent).toBe(true)
})

test('a post the network may have taken is not sent again without a look', async () => {
  const { id } = await draft('fb')
  facebook = 'broken'
  await run(marketing.publishPost(id, staff))
  const kept = await post(id)
  expect(kept?.status).toBe('failed')
  expect(kept?.note).toContain('Facebook answered 502')
  expect(kept?.note).toContain('look at the channel before publishing it again')
  expect(wrote('/1000/feed')).toHaveLength(1)
})

test('a scheduled post to a direct channel goes out with nobody signed in', async () => {
  const { id } = await draft('fb')
  const when = new Date(Date.now() + 60_000)
  await run(marketing.schedulePost(id, when, staff))
  engine = 'skips'

  expect(await run(marketing.tick({ now: new Date(when.getTime() + 1000) }))).toMatchObject({
    sent: 1,
    failed: 0,
  })

  expect(await post(id)).toMatchObject({ status: 'published' })
})

test("a channel that needs a teammate's account says so until one is connected", async () => {
  const before = await run(marketing.reach())

  expect(before.channels.find((c) => c.key === 'me')?.problem).toBe(
    'Connect LinkedIn on the Integrations page',
  )

  const { id } = await draft('me')
  await run(marketing.publishPost(id, staff))

  expect(await post(id)).toMatchObject({
    status: 'failed',
    note: 'Connect LinkedIn on the Integrations page first',
  })

  expect(wrote('/v2/ugcPosts')).toHaveLength(0)
})

test('LinkedIn connects without a refresh token, and a post goes out as the account says', async () => {
  const { url, cookie } = await run(createAuthRequest('linkedin', staff.id))
  const state = new URL(url).searchParams.get('state')
  expect(new URL(url).searchParams.get('scope')).toContain('w_member_social')

  const connection = await run(
    completeAuth(
      'linkedin',
      { code: 'auth-code', state, cookie, query: new URLSearchParams() },
      staff.id,
    ),
  )

  expect(connection).toMatchObject({
    provider: 'linkedin',
    account: 'ana@example.com',
    status: 'connected',
  })

  const after = await run(marketing.reach())

  expect(after.channels.find((c) => c.key === 'me')).toMatchObject({
    delivery: 'direct',
    problem: null,
  })

  const { id } = await draft('me', `Hiring ${tag}`)
  expect((await run(marketing.publishPost(id, staff))).sent).toBe(true)

  const [sent] = wrote('/v2/ugcPosts')
  expect(sent?.authorization).toBe('Bearer linkedin-access')

  expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
    author: 'urn:li:person:abc',
    lifecycleState: 'PUBLISHED',
  })

  expect(await post(id)).toMatchObject({
    status: 'published',
    externalId: 'urn:li:share:77',
    externalUrl: 'https://www.linkedin.com/feed/update/urn:li:share:77',
  })
})

test("a network the app adds is posted to with the app's own code and limit", async () => {
  const tooLong = await failure(
    marketing.draftPost({ channel: 'toot', body: 'a'.repeat(501), link: null }, staff),
  )

  expect(tooLong.message).toBe('Mastodon takes 500 characters and this is 501')

  const { id } = await draft('toot', 'Hello fediverse')
  expect((await run(marketing.publishPost(id, staff))).sent).toBe(true)
  expect(tooted).toEqual(['Hello fediverse'])

  expect(await post(id)).toMatchObject({
    status: 'published',
    externalId: 'toot_1',
    externalUrl: 'https://mastodon.example/@acme/1',
  })
})

test("what the app's code throws is what the team reads", async () => {
  const { id } = await draft('toot', 'boom')
  await run(marketing.publishPost(id, staff))
  const kept = await post(id)
  expect(kept?.status).toBe('failed')
  expect(kept?.note).toContain('The instance is closed')
})

test('a network nothing here knows is handed to its workflow', async () => {
  const reach = await run(marketing.reach())

  expect(reach.channels.find((c) => c.key === 'sky')).toMatchObject({
    delivery: 'swirls',
    problem: null,
  })

  const { id } = await draft('sky')
  await run(marketing.publishPost(id, staff))
  expect(started.map((s) => s.name)).toEqual(['publish_bluesky'])
  expect(await post(id)).toMatchObject({ status: 'publishing' })
})

test('the page is told how each channel is reached, and no token', async () => {
  const reach = await run(marketing.reach())

  expect(reach.channels.map((c) => [c.key, c.delivery])).toEqual([
    ['page', 'swirls'],
    ['feed', 'swirls'],
    ['fb', 'direct'],
    ['me', 'direct'],
    ['toot', 'direct'],
    ['sky', 'swirls'],
  ])

  expect(reach.channels.find((c) => c.key === 'toot')).toMatchObject({
    network: 'Mastodon',
    limit: 500,
  })

  expect(reach.ads.map((a) => [a.key, a.delivery])).toEqual([
    ['meta', 'direct'],
    ['search', 'swirls'],
  ])

  expect(JSON.stringify(reach)).not.toContain('business-token')

  delete process.env['META_ACCESS_TOKEN']
  const without = await run(marketing.reach())

  expect(without.channels.find((c) => c.key === 'fb')?.problem).toBe(
    "Set META_ACCESS_TOKEN in the CRM's environment",
  )
})
