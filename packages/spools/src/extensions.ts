/**
 * What an app's own server code (src/app/extensions.ts) imports: the contract
 * it fills in, and the framework's functions as promises.
 */
export {
  type Actor,
  defineExtensions,
  type Extensions,
  type Hooks,
  type RunContext,
  type RunResult,
  type RunTargetHandler,
} from './crm/extensions'
export * from './server/extension-api'
