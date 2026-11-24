---
'@swirls/spools': minor
---

Marketing: a page for the business's website, its social posts and its ad results, set up
under `marketing` in `crm.config.json`.

- **Website.** The page checks which tracking tags the site carries (Tag Manager, Google
  Analytics, Google Ads, Meta Pixel, LinkedIn Insight) against the ids in the config, and
  gives the install code for the ones that are missing. A `site_profile` workflow reads
  the site so the assistant's drafts sound like the business.
- **Posts.** Drafts for LinkedIn, X and Facebook pages, published now or at a set time. A
  teammate approves each one: the assistant can draft and nothing more. A post is never
  sent twice.
- **Ads.** Spend and results by campaign for Meta Ads and Google Ads.
- **Networks are yours to add.** The CRM reaches the built-in networks itself, with a
  teammate's connected account or a token from the environment. An app adds a network, or
  replaces a built-in one, under `marketing` in `src/app/extensions.ts`. Any channel can
  go through a Swirls workflow instead with `"via": "swirls"`.

An integration provider can now set `refreshToken: 'optional'`, for a provider that issues
a long-lived access token and no refresh token (LinkedIn does, for most apps).

To add it to an existing Spool:

- Add `src/routes/_crm/marketing.tsx` and `src/routes/api/cron/marketing.ts`, as in the
  starter.
- Copy `swirls/marketing.swirls` from the starter, and the two new tool workflows
  (`crm_marketing_context`, `crm_draft_post`) in `swirls/assistant.swirls`, then
  `swirls deploy`.
- Run `bun run crm:gen` and `bun run db:push`: there are three new tables
  (`marketing_sites`, `marketing_posts`, `marketing_ads`).
- On a serverless host, point a cron job at `/api/cron/marketing`.

`marketing` is now a reserved route: an object can no longer have that key.
