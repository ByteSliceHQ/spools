/**
 * Spools: a composable framework for building a CRM. An app describes its Spool
 * with `defineSpool` in src/spool.server.ts. See docs/architecture.md.
 */
export type { PublicCrmConfig } from './crm/config'
export type { Filters } from './crm/filters'
export { defineSpool, type Spool, type SpoolOptions } from './server/spool'
