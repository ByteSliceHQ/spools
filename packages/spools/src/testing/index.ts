/**
 * What a Spool's own tests use, and the framework's: running Effect programs on
 * the app's runtime, putting stand-ins under it, and a file store held in memory.
 *
 *   import { run, failure, installStandIns, createFakeStore } from '@swirls/spools/testing'
 *
 * Tests only. Call `defineSpool` first (a preload file does), as the server does
 * when it starts. See docs/server-code.md.
 */
export { createFakeStore, type FakeStore } from './fake-file-store'
export {
  bodyText,
  db,
  failure,
  installLiveServices,
  installStandIns,
  run,
  runWithEnv,
  testRuntime,
  withEnv,
} from './run'
