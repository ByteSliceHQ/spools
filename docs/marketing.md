# Marketing: the website, social posts and ads

The Marketing page (`/marketing`) is where the team sees how the business shows up
outside the CRM:

- **Website.** Which tracking tags the site carries, the code to paste for the ones it
  is missing, and what the assistant has learned about the business from it.
- **Posts.** Drafts for each social channel, a time to send each one, and what went out.
  LinkedIn, X and Facebook pages work out of the box.
- **Ads.** What each campaign spent and brought in over the last 30 days, for Meta Ads
  and Google Ads.

The page appears once `crm.config.json` has a [`marketing`](configuration.md#marketing)
block. A website is enough to start:

```json
"marketing": { "website": "https://acme.com" }
```

> **Status:** built and tested against stand-ins for every network, the agent engine and
> the website. Nothing here has been run against a live LinkedIn, X, Facebook, Meta Ads or
> Google Ads account yet. Send a test post to each channel before you rely on it.

## How a network is reached

A channel or an ad account names a `network`. Each network is reached one of two ways:

- **Directly.** The CRM calls the network's API itself. This is the default for the
  networks below, and it needs no agent engine.
- **Through Swirls.** A workflow of your [Swirls](swirls.md) project calls the network
  and answers through the [tool API](swirls.md#how-the-app-and-swirls-talk). The account
  is then a Swirls connection, and the CRM stores no token for it. Set `"via": "swirls"`
  on the channel or ad account.

| `network`  | What it is            | Directly, the CRM uses                                            | Through Swirls     |
| ---------- | --------------------- | ----------------------------------------------------------------- | ------------------ |
| `linkedin` | Posts, page or person | A teammate's LinkedIn account, connected on the Integrations page | `publish_linkedin` |
| `x`        | Posts                 | A teammate's X account, connected on the Integrations page        | `publish_x`        |
| `facebook` | Posts to a page       | `META_ACCESS_TOKEN`                                               | `publish_facebook` |
| `meta`     | Ad results            | `META_ACCESS_TOKEN`                                               | `ads_meta`         |
| `google`   | Ad results            | A teammate's Google Ads account, and `GOOGLE_ADS_DEVELOPER_TOKEN` | `ads_google`       |

A network that is not in this table works too: [add it](#adding-a-network) in your app's
code, or write a workflow for it. The Marketing page says how each channel is reached and,
when one is not ready, what is missing.

Which to choose: reaching a network directly means registering your own app with it,
as you do with Google or Microsoft for mailboxes. Going through Swirls means the app is
Swirls's and you only sign in.

### Set up a network to be reached directly

Connected accounts need the [vault](integrations.md#setup), `APP_URL` and `APP_SECRET`,
as every integration does. A network's account is offered on the Integrations page once
a channel or ad account in the config uses it. Any teammate can connect it. The account is
then shared: the CRM posts through it whoever presses the button, so connect the account
the business posts as, not a personal one you would not lend. Its tokens stay sealed in
the vault, and no teammate can read them.

It is a [shared connection](integrations.md#shared-connections) like any other: the page
lists it under **Shared with the team** for everyone, with who connected it, and any
teammate can reconnect or disconnect it, so it does not depend on the person who
connected it still being here. An account connected before shared connections were
listed this way needs nothing done to it.

To limit who may connect, reconnect and disconnect these accounts, say who under
`marketing` in `src/app/extensions.ts`:

```ts
export default defineExtensions({
  marketing: {
    // Email addresses, or (user) => boolean, as `canManage` on a provider of your own.
    canManage: ['marketing@acme.example'],
  },
})
```

It applies to every built-in network's account (LinkedIn, X, Google Ads). Everyone else
still sees the account on the Integrations page and publishes through it; they are not
shown the buttons, and the server refuses them whatever they send. Left out, any teammate
may, as before. The rule works exactly as a provider's
[`canManage`](integrations.md#share-a-provider-with-the-team) does: a function that
throws lets nobody in. A provider of your own with the same id still replaces the
built-in one, and then its own `canManage` is the one that counts.

**LinkedIn.** Create an app at linkedin.com/developers and add the products _Sign In with
LinkedIn using OpenID Connect_ and _Share on LinkedIn_. Posting to a company page needs
the _Community Management API_ instead, which LinkedIn reviews. Redirect address:
`{APP_URL}/api/integrations/linkedin/callback`.

```sh
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
```

LinkedIn gives most apps a token that lasts 60 days and nothing to renew it with. When it
runs out the connection shows "Needs reconnecting".

**X.** Create a project and app at developer.x.com with OAuth 2.0 turned on, type
_Web App_. Redirect address: `{APP_URL}/api/integrations/x/callback`.

```sh
X_CLIENT_ID=
X_CLIENT_SECRET=
```

**Facebook pages and Meta Ads.** In Meta Business settings, create a system user, give it
the page and the ad account, and generate a token with `pages_manage_posts`,
`pages_read_engagement` and `ads_read`. A system user's token belongs to the business and
does not expire, so nobody connects anything.

```sh
META_ACCESS_TOKEN=
```

**Google Ads.** Use the OAuth client you have for [Google](integrations.md#2-google), add
the redirect address `{APP_URL}/api/integrations/google_ads/callback`, and enable the
Google Ads API for the project. Google Ads also asks for a developer token with every
call, from the API Center of a manager account.

```sh
GOOGLE_ADS_DEVELOPER_TOKEN=
# Only when the account is reached through a manager account: the manager's id.
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
# Google retires each API version a year after its release. Default: v26.
GOOGLE_ADS_API_VERSION=
```

### Set up a network to go through Swirls

Copy [`examples/swirls/marketing-networks.swirls`](../examples/swirls/marketing-networks.swirls)
into your `swirls/` folder, keep the workflows you use, run `swirls deploy`, and connect
each account on the project's Connections page. LinkedIn and X are in the Swirls catalog.
Facebook and Google Ads are providers a project gets through Composio: until yours has
them, `swirls doctor` warns and a deploy that includes them fails.

## The website

### Tracking tags

Name the tags the business uses, by id:

```json
"marketing": {
  "website": "https://acme.com",
  "tags": {
    "gtm": "GTM-ABC1234",
    "ga4": "G-ABCDE12345",
    "googleAds": "AW-123456789",
    "metaPixel": "1234567890123456",
    "linkedinInsight": "7654321"
  }
}
```

**Check the site** reads the home page and compares what it carries with that list:

| The page says                           | What it means                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| On your site                            | The tag is in the page with the id you named                                                        |
| Not on your site                        | You named an id and the page has no such tag. **Get the code** shows what to paste and where        |
| Not in the page. Tag Manager may add it | The id is not in the page's source, but the page loads Tag Manager, which may add it in the browser |
| Your site has a different one           | The page carries this tag with another id. One of the two is wrong                                  |
| Not used                                | Neither the config nor the site has it. The card says where to find the id                          |

The code is each vendor's own install snippet with your id filled in. An id is checked
against its vendor's form when the config is read, so nothing else can reach a snippet.

The check reads the page as the server sends it. It does not run the page's scripts, so
it cannot see inside a Tag Manager container, and it reads the home page only.

The address fetched is the one in the config. Nobody using the CRM can point it elsewhere.

### What the business is

**Read the website** starts the `site_profile` workflow. It reads the home page and keeps
four things: what the business does, who it sells to, how it writes, and what it sells.
The assistant reads them (`crm_marketing_context`) before it drafts a post, so a draft
sounds like the business. Read it again when the site changes.

## Posts

Add the pages you post to:

```json
"channels": {
  "company": { "label": "LinkedIn page", "network": "linkedin", "account": "urn:li:organization:12345" },
  "x": { "label": "X", "network": "x", "account": "acme" }
}
```

| `network`  | `account` is                                                                               |
| ---------- | ------------------------------------------------------------------------------------------ |
| `linkedin` | The author's URN: `urn:li:organization:<id>` for a page, `urn:li:person:<id>` for a person |
| `facebook` | The page's id                                                                              |
| `x`        | The handle, for your own reference. The connection decides which account posts             |

A post is a draft until a teammate schedules it or presses **Publish now**. Then:

1. The CRM takes the post in one step that only one request can win, so two people
   pressing the button, or two schedulers running at once, send it once.
2. It sends the post. Reached directly, the answer comes back in the same request.
   Through Swirls, the CRM starts `publish_<network>` and the workflow answers through
   `post_result`.
3. The post shows **Published** with a link, or **Not sent** with the network's own words.

A link gets `utm_source`, `utm_medium=social` and `utm_campaign` added, so analytics
counts the visits it brings. Parameters the link already has are kept.

**A post is never sent twice by the CRM.** When a post's fate is unknown (the network
did not answer, or answered with a server error after the post was sent), it is marked
**Not sent** with a note to look at the channel first: it may have gone out. A refusal
the network gave in words is a plain **Not sent**, and can be sent again. Through Swirls,
if a run starts and no answer comes back within 15 minutes, the post says so, and a
teammate who has looked at the channel can say it did not go out.

**The assistant drafts and a person publishes.** The tool API has `draft_post` and no
way to schedule or publish. Text the assistant read (a note, an email, a web page) could
have shaped the post, so each one waits for a teammate.

### Scheduled posts

A server that stays up publishes what is due once a minute. On a serverless host
(`SERVERLESS=1`, or Vercel), point a cron job at `/api/cron/marketing` with
`Authorization: Bearer $CRON_SECRET`, as for [sequences](campaigns.md#operations).

A channel reached directly needs nothing more. For one that goes through Swirls, nobody
is signed in when a scheduled post falls due, so Swirls needs a credential of its own:
set `SWIRLS_API_KEY`. Without it the post is marked **Not sent** and says why.
**Publish now** works either way.

## Ads

```json
"ads": {
  "meta": { "label": "Meta Ads", "network": "meta", "account": "1234567890" },
  "search": { "label": "Google Ads", "network": "google", "account": "1234567890" }
}
```

`account` is the ad account's number: the digits after `act_` for Meta, the customer id
without dashes for Google Ads.

**Read again** reads each account on its own, so one that fails leaves the others. Each
read takes the account's campaigns and their last 30 days, and replaces what was held for
that account. The page shows spend, impressions, clicks, click rate, results and cost per
result.

The CRM shows ad results and does not change ads. Budgets, bids and pausing stay in the
ad network.

For Meta, a result is a lead (the `lead` action). For Google Ads it is a conversion as
the account defines one.

## Adding a network

### In your app's code

Add it under `marketing` in `src/app/extensions.ts`. The key is what a channel names as
its `network`; one of the same key as a built-in network replaces it.

```ts
import { defineExtensions } from '@swirls/spools/extensions'

export default defineExtensions({
  marketing: {
    posts: {
      mastodon: {
        label: 'Mastodon',
        limit: 500,
        // Where the token comes from: an environment variable, or { integration: '<id>' }
        // for an account teammates connect (one of your `integrations`).
        access: { env: 'MASTODON_TOKEN' },
        async publish({ text, token }) {
          const res = await fetch('https://mastodon.example/api/v1/statuses', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ status: text }),
          })

          if (!res.ok) throw new Error(`Mastodon answered ${res.status}`)
          const status = await res.json()
          return { id: status.id, url: status.url }
        },
      },
    },
    ads: {
      // read({ account, token, days }) returns the account's campaigns with their results.
    },
  },
})
```

```json
"channels": { "fedi": { "label": "Mastodon", "network": "mastodon", "account": "acme" } }
```

What `publish` throws is what the team reads on the post. The CRM cannot know whether a
post that threw went out, so it adds the note to look at the channel first.

### As a workflow

A channel whose network has no code is handed to Swirls. Write a workflow named
`publish_<network>` (or `ads_<network>`), as in
[`marketing-networks.swirls`](../examples/swirls/marketing-networks.swirls): its root takes
the post and the channel, and its last node posts to `/api/swirls/tools/post_result` (or
`/api/swirls/tools/save_ads`). Run `swirls doctor`, then `swirls deploy`.

## Troubleshooting

| What you see                                                  | What it means                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No Marketing link in the sidebar                              | `crm.config.json` has no `marketing` block                                                   |
| "Swirls workflow "publish_facebook" is not deployed"          | The workflow for that network is not in your `swirls/` folder, or has not been deployed      |
| "Not sent: nobody is signed in and SWIRLS_API_KEY is not set" | A scheduled post fell due with no credential for Swirls to run as                            |
| A post stays on **Publishing**                                | The workflow failed before it could answer. Open the run in Swirls, then look at the channel |
| "The site could not be reached"                               | The server could not fetch `marketing.website`. The last good check is still shown           |
