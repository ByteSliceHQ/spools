/**
 * What an app's own server code (src/app/extensions.ts) imports: the contract
 * it fills in, and the framework's functions as promises.
 */
export {
  type Actor,
  type AdCampaignResults,
  type AdNetwork,
  defineExtensions,
  type Extensions,
  type Hooks,
  type NetworkAccess,
  type PostNetwork,
  type PostToPublish,
  type PublishedPost,
  type RunContext,
  type RunResult,
  type RunTargetHandler,
} from './crm/extensions'
export * from './server/extension-api'
