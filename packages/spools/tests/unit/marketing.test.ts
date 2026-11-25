import { describe, expect, test } from 'bun:test'

import { crmConfigSchema } from '../../src/crm/config-schema'
import {
  checkPost,
  clickRate,
  costPer,
  detectTags,
  POST_SPECS,
  postLength,
  postText,
  TAG_KINDS,
  tagReport,
  tagSnippets,
  withUtm,
} from '../../src/crm/marketing'
import { providersFor } from '../../src/server/marketing-providers'

const page = `<!doctype html><html><head>
<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC1234');</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABCDE12345"></script>
<script>gtag('config', 'G-ABCDE12345'); gtag("config", "AW-123456789");</script>
<script>fbq('init', '1234567890123456'); fbq('track', 'PageView');</script>
</head><body>
<noscript><img src="https://px.ads.linkedin.com/collect/?pid=7654321&fmt=gif" /></noscript>
</body></html>`

describe('detectTags', () => {
  test('finds each tag once, however many times the page names it', () => {
    expect(detectTags(page)).toEqual({
      gtm: ['GTM-ABC1234'],
      ga4: ['G-ABCDE12345'],
      googleAds: ['AW-123456789'],
      metaPixel: ['1234567890123456'],
      linkedinInsight: ['7654321'],
    })
  })

  test('a page with no tags has none', () => {
    const found = detectTags('<html><body><p>Order G-STRING from our catalogue</p></body></html>')
    expect(TAG_KINDS.every((kind) => found[kind].length === 0)).toBe(true)
  })

  test('an id in the wrong form is not taken for a tag', () => {
    expect(detectTags(`<script>fbq('init', '12');</script>`).metaPixel).toEqual([])
  })
})

describe('tagReport', () => {
  const status = (rows: ReturnType<typeof tagReport>, kind: string) =>
    rows.find((row) => row.kind === kind)?.status

  test('says where each tag stands', () => {
    const rows = tagReport(
      { ga4: 'G-ABCDE12345', metaPixel: '9999999999999999', linkedinInsight: '7654321' },
      {
        gtm: [],
        ga4: ['G-ABCDE12345'],
        googleAds: ['AW-123456789'],
        metaPixel: [],
        linkedinInsight: ['1111111'],
      },
    )

    expect(status(rows, 'ga4')).toBe('installed')
    expect(status(rows, 'metaPixel')).toBe('missing')
    expect(status(rows, 'linkedinInsight')).toBe('different')
    expect(status(rows, 'googleAds')).toBe('found')
    expect(status(rows, 'gtm')).toBe('unset')
  })

  test("a tag that isn't in the page may be inside Tag Manager", () => {
    const rows = tagReport(
      { gtm: 'GTM-ABC1234', metaPixel: '9999999999999999' },
      { gtm: ['GTM-ABC1234'], ga4: [], googleAds: [], metaPixel: [], linkedinInsight: [] },
    )

    expect(status(rows, 'gtm')).toBe('installed')
    expect(status(rows, 'metaPixel')).toBe('unseen')
  })

  test('before any scan, a tag with an id is missing and one without is unset', () => {
    const rows = tagReport({ ga4: 'G-ABCDE12345' }, null)
    expect(status(rows, 'ga4')).toBe('missing')
    expect(status(rows, 'gtm')).toBe('unset')
  })
})

describe('tagSnippets', () => {
  test('the code for a tag is found again by the scan', () => {
    const ids = {
      gtm: 'GTM-ABC1234',
      ga4: 'G-ABCDE12345',
      googleAds: 'AW-123456789',
      metaPixel: '1234567890123456',
      linkedinInsight: '7654321',
    }

    for (const kind of TAG_KINDS) {
      const html = tagSnippets(kind, ids[kind])
        .map((snippet) => snippet.code)
        .join('\n')

      expect(detectTags(html)[kind]).toEqual([ids[kind]])
    }
  })

  test('an id that is not well formed is never written into a script', () => {
    expect(tagSnippets('ga4', `G-X');alert(1);//`)).toEqual([])
    expect(tagSnippets('metaPixel', '"><script>')).toEqual([])
  })
})

describe('posts', () => {
  test('the link goes on a line of its own', () => {
    expect(postText('  Hello  ', 'https://acme.com/a')).toBe('Hello\n\nhttps://acme.com/a')
    expect(postText('Hello', null)).toBe('Hello')
  })

  test('X counts every link as 23 characters', () => {
    const link = `https://acme.com/${'a'.repeat(200)}`
    expect(postLength(POST_SPECS.x, 'Hello', link)).toBe(5 + 2 + 23)
    expect(postLength(POST_SPECS.linkedin, 'Hello', link)).toBe(5 + 2 + link.length)
  })

  test('a post too long for its network is refused, with the numbers', () => {
    expect(checkPost(POST_SPECS.x, 'a'.repeat(281), null)).toEqual([
      'X takes 280 characters and this is 281',
    ])

    expect(checkPost(POST_SPECS.linkedin, 'a'.repeat(281), null)).toEqual([])
  })

  test('an empty post and a link that is not https are refused', () => {
    expect(checkPost(POST_SPECS.linkedin, '   ', null)).toContain('Write something to post')

    expect(checkPost(POST_SPECS.linkedin, 'Hi', 'http://acme.com')).toContain(
      'The link must start with https://',
    )
  })

  test('campaign parameters are added, and the ones a link has are kept', () => {
    expect(withUtm('https://acme.com/a?x=1', { source: 'linkedin', medium: 'social' })).toBe(
      'https://acme.com/a?x=1&utm_source=linkedin&utm_medium=social',
    )

    expect(
      withUtm('https://acme.com/?utm_source=news', {
        source: 'x',
        medium: 'social',
        campaign: 'c',
      }),
    ).toBe('https://acme.com/?utm_source=news&utm_medium=social&utm_campaign=c')
  })
})

test('rates are empty when there is nothing to divide by', () => {
  expect(clickRate(5, 200)).toBe(2.5)
  expect(clickRate(0, 0)).toBeNull()
  expect(costPer(100, 4)).toBe(25)
  expect(costPer(100, 0)).toBeNull()
})

describe('marketing in crm.config.json', () => {
  const base = async () =>
    Bun.file(new URL('../fixtures/example.config.json', import.meta.url)).json()

  const withMarketing = async (marketing: unknown) =>
    crmConfigSchema.safeParse({ ...(await base()), marketing })

  test('a website alone is enough', async () => {
    const parsed = await withMarketing({ website: 'https://acme.com' })
    expect(parsed.success).toBe(true)

    expect(parsed.data?.marketing).toEqual({
      website: 'https://acme.com',
      tags: {},
      channels: {},
      ads: {},
    })
  })

  test('the website must be https, with nothing that names a person', async () => {
    expect((await withMarketing({ website: 'http://acme.com' })).success).toBe(false)
    expect((await withMarketing({ website: 'https://user@acme.com' })).success).toBe(false)
    expect((await withMarketing({ website: 'https://acme.com/?token=1' })).success).toBe(false)
  })

  test("a tag id must be in its vendor's form", async () => {
    const website = 'https://acme.com'
    expect((await withMarketing({ website, tags: { ga4: 'G-ABCDE12345' } })).success).toBe(true)
    expect((await withMarketing({ website, tags: { ga4: 'UA-1234' } })).success).toBe(false)

    expect((await withMarketing({ website, tags: { metaPixel: "1');alert(1)" } })).success).toBe(
      false,
    )
  })

  test('a channel names any network, and may say how it is reached', async () => {
    const website = 'https://acme.com'
    const channel = { label: 'Page', account: 'urn:li:organization:123' }

    const one = (extra: { network: string; via?: string }) =>
      withMarketing({ website, channels: { page: { ...channel, ...extra } } })

    expect((await one({ network: 'linkedin' })).success).toBe(true)
    expect((await one({ network: 'mastodon', via: 'swirls' })).success).toBe(true)
    expect((await one({ network: 'linkedin', via: 'carrier-pigeon' })).success).toBe(false)
    expect((await one({ network: 'Not A Key' })).success).toBe(false)
  })

  test('"marketing" can\'t be an object key: it is the page\'s address', async () => {
    const config = await base()
    const [first] = Object.values(config.objects)

    expect(
      crmConfigSchema.safeParse({ ...config, objects: { ...config.objects, marketing: first } })
        .success,
    ).toBe(false)
  })
})

type Entry = { label: string; network: string; account: string; via?: string }

describe('the accounts marketing asks teammates to connect', () => {
  const marketing = (channels: Record<string, Entry>, ads: Record<string, Entry> = {}) =>
    crmConfigSchema.shape.marketing.unwrap().parse({ website: 'https://acme.com', channels, ads })

  test('a Spool with no marketing is offered none', () => {
    expect(providersFor(undefined)).toEqual({})
    expect(providersFor(marketing({}))).toEqual({})
  })

  test('only the networks reached directly are offered', () => {
    const offered = providersFor(
      marketing(
        {
          page: { label: 'Page', network: 'linkedin', account: 'urn:li:person:abc' },
          x: { label: 'X', network: 'x', account: 'acme', via: 'swirls' },
        },
        { search: { label: 'Search', network: 'google', account: '1234567890' } },
      ),
    )

    expect(Object.keys(offered).sort()).toEqual(['google_ads', 'linkedin'])
  })

  test('a company page asks LinkedIn for the page scope, a person for their own', () => {
    const scopes = (account: string) =>
      providersFor(marketing({ page: { label: 'Page', network: 'linkedin', account } }))['linkedin']
        ?.scopes

    expect(scopes('urn:li:organization:1')).toContain('w_organization_social')
    expect(scopes('urn:li:person:abc')).toContain('w_member_social')
    expect(scopes('urn:li:person:abc')).not.toContain('w_organization_social')
  })

  test('LinkedIn may connect without a refresh token, X and Google Ads may not', () => {
    const offered = providersFor(
      marketing(
        {
          page: { label: 'Page', network: 'linkedin', account: 'urn:li:person:abc' },
          x: { label: 'X', network: 'x', account: 'acme' },
        },
        { search: { label: 'Search', network: 'google', account: '1234567890' } },
      ),
    )

    expect(offered['linkedin']?.refreshToken).toBe('optional')
    expect(offered['x']?.refreshToken).toBeUndefined()
    expect(offered['google_ads']?.refreshToken).toBeUndefined()
  })
})
