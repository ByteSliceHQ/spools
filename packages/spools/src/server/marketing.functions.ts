import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { z } from 'zod'

import * as marketing from './marketing'
import { Agents } from './runtime/agents'
import { crmHandler } from './runtime/boundary'
import * as config from './runtime/config'

/**
 * Server functions for the Marketing page. Any teammate may use them: the page
 * is the business's, not one person's. What goes out is still a person's
 * decision, since scheduling and publishing are only here, never in the tool API.
 */

const postId = z.object({ id: z.string().uuid() })

/** Everything the page shows, or `null` when the config has no `marketing`. */
export const getMarketingFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('marketing.get', () =>
    Effect.gen(function* () {
      if (!(yield* marketing.current())) {
        return null
      }

      const [site, posts, ads, reach, engine, key] = yield* Effect.all(
        [
          marketing.site(),
          marketing.listPosts(),
          marketing.listAds(),
          marketing.reach(),
          (yield* Agents).configured,
          config.variable('SWIRLS_API_KEY'),
        ],
        { concurrency: 'unbounded' },
      )

      return {
        // Written out field by field, so the page's type names nothing from inside the package.
        site: {
          website: site.website,
          scanError: site.scanError,
          tags: site.tags && {
            gtm: site.tags.gtm,
            ga4: site.tags.ga4,
            googleAds: site.tags.googleAds,
            metaPixel: site.tags.metaPixel,
            linkedinInsight: site.tags.linkedinInsight,
          },
          profile: site.profile && {
            summary: site.profile.summary,
            audience: site.profile.audience,
            voice: site.profile.voice,
            offers: site.profile.offers,
          },
          scannedAt: site.scannedAt?.toISOString() ?? null,
          profiledAt: site.profiledAt?.toISOString() ?? null,
          profileRequestedAt: site.profileRequestedAt?.toISOString() ?? null,
        },
        posts: posts.map((post) => ({
          ...post,
          scheduledAt: post.scheduledAt?.toISOString() ?? null,
          publishedAt: post.publishedAt?.toISOString() ?? null,
          createdAt: post.createdAt.toISOString(),
        })),
        ads: ads.map((ad) => ({
          id: ad.id,
          account: ad.account,
          name: ad.name,
          status: ad.status,
          currency: ad.currency ?? null,
          spend: ad.spend,
          impressions: ad.impressions,
          clicks: ad.clicks,
          conversions: ad.conversions,
          dailyBudget: ad.dailyBudget ?? null,
          periodDays: ad.periodDays,
          syncedAt: ad.syncedAt.toISOString(),
        })),
        /** Each channel and ad account: its network, how it is reached, and what stands in the way. */
        channels: reach.channels,
        accounts: reach.ads,
        /** Whether an agent engine is set up: the website profile needs one, and so does anything reached through it. */
        engine,
        /** Whether the engine can run with nobody signed in, which a scheduled post needs. */
        unattended: !!key,
      }
    }),
  ),
)

export const scanSiteFn = createServerFn({ method: 'POST' }).handler(
  crmHandler('marketing.scanSite', () => marketing.scanSite().pipe(Effect.as({ ok: true }))),
)

export const profileSiteFn = createServerFn({ method: 'POST' }).handler(
  crmHandler('marketing.profileSite', ({ user }) => marketing.profileSite(user)),
)

export const draftPostFn = createServerFn({ method: 'POST' })
  .validator(marketing.draftInput.extend({ id: z.string().uuid().optional() }))
  .handler(
    crmHandler('marketing.draftPost', ({ data: { id, ...draft }, user }) =>
      id
        ? marketing.editPost(id, draft).pipe(Effect.as({ id }))
        : marketing
            .draftPost(draft, { id: user.id, name: user.name })
            .pipe(Effect.map((post) => ({ id: post.id }))),
    ),
  )

export const schedulePostFn = createServerFn({ method: 'POST' })
  .validator(postId.extend({ at: z.iso.datetime() }))
  .handler(
    crmHandler('marketing.schedulePost', ({ data, user }) =>
      marketing.schedulePost(data.id, new Date(data.at), user),
    ),
  )

export const unschedulePostFn = createServerFn({ method: 'POST' })
  .validator(postId)
  .handler(crmHandler('marketing.unschedulePost', ({ data }) => marketing.unschedulePost(data.id)))

export const publishPostFn = createServerFn({ method: 'POST' })
  .validator(postId)
  .handler(
    crmHandler('marketing.publishPost', ({ data, user }) => marketing.publishPost(data.id, user)),
  )

export const releasePostFn = createServerFn({ method: 'POST' })
  .validator(postId)
  .handler(crmHandler('marketing.releasePost', ({ data }) => marketing.releasePost(data.id)))

export const deletePostFn = createServerFn({ method: 'POST' })
  .validator(postId)
  .handler(crmHandler('marketing.deletePost', ({ data }) => marketing.deletePost(data.id)))

export const syncAdsFn = createServerFn({ method: 'POST' }).handler(
  crmHandler('marketing.syncAds', ({ user }) => marketing.syncAds(user)),
)
