import { Context, Effect, Layer, Predicate } from 'effect'

import type { CrmCampaign } from '../crm/config-schema'
import type { SendingHours } from '../crm/sequences'
import { crmConfig } from './spool'

/**
 * The email sequences the CRM runs: `campaigns` in crm.config.json, with the
 * app's sending hours and time zone. Read each time, so a config reloaded in
 * development applies at once. Tests run their own with `Sequences.layerTest`.
 */
export type SequenceSource = {
  campaigns: Record<string, CrmCampaign>
  hours?: SendingHours
  zone: string
}

const fromConfig = (): SequenceSource => ({
  campaigns: crmConfig().campaigns,
  hours: crmConfig().app.sendingHours,
  zone: crmConfig().app.timezone,
})

export class Sequences extends Context.Service<
  Sequences,
  { readonly current: Effect.Effect<SequenceSource> }
>()('crm/Sequences') {
  static readonly layer = Layer.succeed(
    Sequences,
    Sequences.of({ current: Effect.sync(fromConfig) }),
  )

  /** The config's sequences with these parts replaced (tests). Pass a function to change them as a test goes. */
  static readonly layerTest = (
    replace: Partial<SequenceSource> | (() => Partial<SequenceSource>),
  ) =>
    Layer.succeed(
      Sequences,
      Sequences.of({
        current: Effect.sync(() => ({
          ...fromConfig(),
          ...(Predicate.isFunction(replace) ? replace() : replace),
        })),
      }),
    )
}
