import type { CrmConfig } from './config-schema'

/** The config as the browser gets it: without the access list and the automations. */
export type PublicCrmConfig = Omit<CrmConfig, 'access' | 'automations'>

export function toPublicConfig(cfg: CrmConfig): PublicCrmConfig {
  const { access: _access, automations: _automations, ...rest } = cfg
  return rest
}
