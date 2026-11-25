/**
 * Marketing, the parts with no server in them: the tracking tags a website
 * carries, the networks a post can go to, and what a post must satisfy before
 * it is sent. Shared by the server (src/server/marketing.ts), the config schema
 * and the Marketing page. See docs/marketing.md.
 */

/** The tracking tags the CRM knows how to find on a page and how to write out. */
export const TAG_KINDS = ['gtm', 'ga4', 'googleAds', 'metaPixel', 'linkedinInsight'] as const
export type TagKind = (typeof TAG_KINDS)[number]

export type TagIds = Partial<Record<TagKind, string>>

type TagSpec = {
  label: string
  /** What it is for, in a line. */
  purpose: string
  /** What an id looks like, for the config and for anything put into a snippet. */
  id: RegExp
  example: string
  /** Where the id is found in the vendor's own product. */
  findIt: string
}

export const TAGS: Record<TagKind, TagSpec> = {
  gtm: {
    label: 'Google Tag Manager',
    purpose: 'One container that loads your other tags, so they can change without a deploy',
    id: /^GTM-[A-Z0-9]{4,12}$/,
    example: 'GTM-ABC1234',
    findIt: 'Tag Manager, top of the workspace',
  },
  ga4: {
    label: 'Google Analytics',
    purpose: 'Counts visits and where they came from',
    id: /^G-[A-Z0-9]{4,14}$/,
    example: 'G-ABCDE12345',
    findIt: 'Analytics, Admin, Data streams, Measurement ID',
  },
  googleAds: {
    label: 'Google Ads',
    purpose: 'Tells Google Ads which clicks became leads',
    id: /^AW-[0-9]{6,14}$/,
    example: 'AW-123456789',
    findIt: 'Google Ads, Goals, Conversions, Tag setup',
  },
  metaPixel: {
    label: 'Meta Pixel',
    purpose: 'Tells Facebook and Instagram ads which clicks became leads',
    id: /^[0-9]{8,20}$/,
    example: '1234567890123456',
    findIt: 'Meta Events Manager, Data sources',
  },
  linkedinInsight: {
    label: 'LinkedIn Insight Tag',
    purpose: 'Tells LinkedIn ads which clicks became leads',
    id: /^[0-9]{4,12}$/,
    example: '1234567',
    findIt: 'LinkedIn Campaign Manager, Analyze, Insight Tag (Partner ID)',
  },
}

export const isTagKind = (value: string): value is TagKind =>
  TAG_KINDS.some((kind) => kind === value)

/** Whether `id` is well formed for its tag. Only such an id is ever written into a snippet. */
export const isTagId = (kind: TagKind, id: string): boolean => TAGS[kind].id.test(id)

/** Every id of each tag found on a page, in the order they appear. */
export type DetectedTags = Record<TagKind, string[]>

/**
 * Where each tag's id shows up in a page's source. Each pattern has one group:
 * the id. Ids are checked against the tag's own format afterwards.
 */
const SIGNS: Record<TagKind, RegExp[]> = {
  gtm: [
    /googletagmanager\.com\/(?:gtm\.js|ns\.html)\?id=(GTM-[A-Z0-9]+)/g,
    /['"](GTM-[A-Z0-9]{4,12})['"]/g,
  ],
  ga4: [
    /googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]+)/g,
    /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/g,
  ],
  googleAds: [
    /googletagmanager\.com\/gtag\/js\?id=(AW-[0-9]+)/g,
    /gtag\(\s*['"]config['"]\s*,\s*['"](AW-[0-9]+)['"]/g,
  ],
  metaPixel: [
    /fbq\(\s*['"]init['"]\s*,\s*['"]?([0-9]{8,20})/g,
    /facebook\.com\/tr\?id=([0-9]{8,20})/g,
  ],
  linkedinInsight: [
    /_linkedin_partner_id\s*=\s*['"]?([0-9]{4,12})/g,
    /px\.ads\.linkedin\.com\/collect\/?\?pid=([0-9]{4,12})/g,
  ],
}

/**
 * The tags in a page's HTML. It reads the source as served: a tag that Tag
 * Manager adds in the browser is not in it, which is why `tagReport` says
 * "may be in Tag Manager" and not "missing" when the page has a container.
 */
export function detectTags(html: string): DetectedTags {
  const found: DetectedTags = {
    gtm: [],
    ga4: [],
    googleAds: [],
    metaPixel: [],
    linkedinInsight: [],
  }

  for (const kind of TAG_KINDS) {
    for (const sign of SIGNS[kind]) {
      for (const match of html.matchAll(sign)) {
        const id = match[1]

        if (id !== undefined && isTagId(kind, id) && !found[kind].includes(id)) {
          found[kind].push(id)
        }
      }
    }
  }

  return found
}

/**
 * How one tag stands:
 * - `installed`: the id you use is on the site.
 * - `missing`: you have an id, and the site has no such tag (and no Tag Manager it could be inside).
 * - `unseen`: you have an id, it is not in the page's source, but the page loads Tag Manager, which may add it.
 * - `different`: the site carries this tag with another id.
 * - `found`: the site carries the tag, and the config names no id for it.
 * - `unset`: neither the config nor the site has it.
 */
export type TagStatus = 'installed' | 'missing' | 'unseen' | 'different' | 'found' | 'unset'

export type TagRow = {
  kind: TagKind
  label: string
  purpose: string
  status: TagStatus
  /** The id from the config, when there is one. */
  id: string | null
  /** The ids the site carries. */
  onSite: string[]
}

/** Each tag: what the config says you use, against what the last scan found on the site. */
export function tagReport(ids: TagIds, detected: DetectedTags | null): TagRow[] {
  const viaContainer = (detected?.gtm.length ?? 0) > 0

  return TAG_KINDS.map((kind) => {
    const id = ids[kind] ?? null
    const onSite = detected?.[kind] ?? []
    const { label, purpose } = TAGS[kind]
    const row = { kind, label, purpose, id, onSite }

    if (id === null) {
      return { ...row, status: onSite.length > 0 ? 'found' : 'unset' }
    }

    if (onSite.includes(id)) {
      return { ...row, status: 'installed' }
    }

    if (onSite.length > 0) {
      return { ...row, status: 'different' }
    }

    return { ...row, status: viaContainer && kind !== 'gtm' ? 'unseen' : 'missing' }
  })
}

/** A piece of a tag to paste into the site, and where it goes. */
export type Snippet = { where: 'head' | 'body'; note: string; code: string }

const gtag = (id: string): Snippet => ({
  where: 'head',
  note: 'As high in <head> as possible, on every page.',
  code: `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${id}');
</script>`,
})

/** The vendor's own install code for each tag, around an id that has already been checked. */
const SNIPPETS: Record<TagKind, (id: string) => Snippet[]> = {
  gtm: (id) => [
    {
      where: 'head',
      note: 'As high in <head> as possible, on every page.',
      code: `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${id}');</script>`,
    },
    {
      where: 'body',
      note: 'Immediately after the opening <body> tag.',
      code: `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`,
    },
  ],
  ga4: (id) => [gtag(id)],
  googleAds: (id) => [gtag(id)],
  metaPixel: (id) => [
    {
      where: 'head',
      note: 'Before </head>, on every page.',
      code: `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>`,
    },
  ],
  linkedinInsight: (id) => [
    {
      where: 'body',
      note: 'Before </body>, on every page.',
      code: `<script type="text/javascript">
_linkedin_partner_id = "${id}";
window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
window._linkedin_data_partner_ids.push(_linkedin_partner_id);
</script><script type="text/javascript">
(function(l) {
if (!l){window.lintrk = function(a,b){window.lintrk.q.push([a,b])};
window.lintrk.q=[]}
var s = document.getElementsByTagName("script")[0];
var b = document.createElement("script");
b.type = "text/javascript";b.async = true;
b.src = "https://snap.licdn.com/li.lms-analytics/insight.min.js";
s.parentNode.insertBefore(b, s);})(window.lintrk);
</script>
<noscript><img height="1" width="1" style="display:none;" alt=""
src="https://px.ads.linkedin.com/collect/?pid=${id}&fmt=gif" /></noscript>`,
    },
  ],
}

/**
 * The vendor's own install code for a tag, with the id filled in. Empty for an
 * id that isn't well formed: nothing unchecked is ever written into a script.
 */
export const tagSnippets = (kind: TagKind, id: string): Snippet[] =>
  isTagId(kind, id) ? SNIPPETS[kind](id) : []

/** What the page and the checks need to know of a network a post can go to. */
export type PostSpec = {
  label: string
  /** The longest post the network takes. */
  limit: number
  /** What a link counts as, where the network counts every link the same. */
  linkLength?: number
}

/** The longest post body the CRM stores, whatever the network. */
export const POST_MAX = 63_206

/** The networks a Spool can post to without adding one. An app adds more in src/app/extensions.ts. */
export const POST_SPECS = {
  linkedin: { label: 'LinkedIn', limit: 3000 },
  facebook: { label: 'Facebook', limit: POST_MAX },
  x: { label: 'X', limit: 280, linkLength: 23 },
} satisfies Record<string, PostSpec>

/** The ad networks a Spool can read without adding one. */
export const AD_LABELS = { meta: 'Meta Ads', google: 'Google Ads' } satisfies Record<string, string>

/**
 * How a channel or an ad account is reached: `direct` is the CRM calling the
 * network itself, `swirls` a workflow of the agent engine doing it.
 */
export const DELIVERIES = ['direct', 'swirls'] as const
export type Delivery = (typeof DELIVERIES)[number]

/**
 * Where a post is in its life:
 * - `draft`: written, going nowhere yet. The assistant can only make drafts.
 * - `scheduled`: a teammate set a time.
 * - `publishing`: handed to the agent engine, which has not yet said how it went.
 * - `published` / `failed`: what the engine said.
 */
export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const
export type PostStatus = (typeof POST_STATUSES)[number]

export const isPostStatus = (value: string): value is PostStatus =>
  POST_STATUSES.some((status) => status === value)

/** How long a post may wait for the engine's answer before the page says it never came. */
export const PUBLISH_ANSWER_MS = 15 * 60_000

const isHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** The post as the network receives it: the body, then the link on a line of its own. */
export const postText = (body: string, link: string | null | undefined): string =>
  link ? `${body.trim()}\n\n${link}` : body.trim()

/** How long the network counts a post to be. */
export function postLength(spec: PostSpec, body: string, link: string | null | undefined): number {
  const { linkLength } = spec
  const text = body.trim()

  if (!link) {
    return text.length
  }

  return text.length + 2 + (linkLength ?? link.length)
}

/** What stops a post from being sent to a network, in words for whoever wrote it. Empty when nothing does. */
export function checkPost(spec: PostSpec, body: string, link: string | null | undefined): string[] {
  const problems: string[] = []
  const { label, limit } = spec

  if (body.trim().length === 0) {
    problems.push('Write something to post')
  }

  if (link && !isHttps(link)) {
    problems.push('The link must start with https://')
  }

  const length = postLength(spec, body, link)

  if (length > limit) {
    problems.push(`${label} takes ${limit} characters and this is ${length}`)
  }

  return problems
}

/**
 * A link with the campaign parameters analytics reads, so a visit from a post
 * is counted as coming from it. Parameters the link already has are kept.
 */
export function withUtm(
  link: string,
  utm: { source: string; medium: string; campaign?: string | null },
): string {
  let url: URL

  try {
    url = new URL(link)
  } catch {
    return link
  }

  const set = (key: string, value: string | null | undefined) => {
    if (value && !url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
  }

  set('utm_source', utm.source)
  set('utm_medium', utm.medium)
  set('utm_campaign', utm.campaign)
  return url.toString()
}

/** What the agent engine learned about the business from its website. */
export type SiteSummary = {
  /** What the business does, in two or three sentences. */
  summary: string
  /** Who it sells to. */
  audience: string
  /** How it writes: the tone a post or an ad should keep. */
  voice: string
  /** What it sells, as short names. */
  offers: string[]
}

/** Clicks for every hundred impressions, or null when nothing was shown. */
export const clickRate = (clicks: number, impressions: number): number | null =>
  impressions > 0 ? (clicks / impressions) * 100 : null

/** What each result cost, or null when there were none. */
export const costPer = (spend: number, results: number): number | null =>
  results > 0 ? spend / results : null
