import { Context, Effect, Layer, Predicate } from 'effect'

import type { CrmMarketing } from '../crm/config-schema'
import { crmConfig } from './spool'

/**
 * What the CRM markets: `marketing` in crm.config.json, or nothing when the
 * config has none. Read each time, so a config reloaded in development
 * applies at once. Tests run their own with `MarketingSource.layerTest`.
 */
export class MarketingSource extends Context.Service<
  MarketingSource,
  { readonly current: Effect.Effect<CrmMarketing | undefined> }
>()('crm/MarketingSource') {
  static readonly layer = Layer.succeed(
    MarketingSource,
    MarketingSource.of({ current: Effect.sync(() => crmConfig().marketing) }),
  )

  /** This marketing block in place of the config's (tests). Pass a function to change it as a test goes. */
  static readonly layerTest = (
    replace: CrmMarketing | undefined | (() => CrmMarketing | undefined),
  ) =>
    Layer.succeed(
      MarketingSource,
      MarketingSource.of({
        current: Effect.sync(() => (Predicate.isFunction(replace) ? replace() : replace)),
      }),
    )
}
