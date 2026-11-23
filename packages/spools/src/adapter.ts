/**
 * What an adapter is written with: the ports, the types they deal in, and the
 * helpers that keep every adapter's time limits and failures the same. See
 * docs/adapters.md.
 */
export { titleFrom } from './crm/assistant'
export type { Adapter, Env, Feature, Requirement } from './server/runtime/adapter'
export { atLeast } from './server/runtime/adapter'
export {
  Agents,
  type AgentsAdapter,
  type AssistantChat,
  CHATS_LISTED,
  type Run,
} from './server/runtime/agents'
export {
  Auth,
  type AuthAdapter,
  type AuthUser,
  type Session,
  type SignInAccount,
} from './server/runtime/auth'
export * as config from './server/runtime/config'
export {
  type Delivery,
  type DeliveryEvent,
  Email,
  type EmailAdapter,
  type OutboundEmail,
} from './server/runtime/email'
export {
  AgentsError,
  AuthError,
  DatabaseError,
  EmailError,
  FilesError,
  messageOf,
  Timeout,
  VaultError,
} from './server/runtime/errors'
export {
  FileStore,
  type FilesAdapter,
  type OpenedFile,
  type StoredFile,
  type StoredFolder,
  type UploadOutcome,
  type UploadTarget,
} from './server/runtime/files'
export { type Policy, policies, withPolicy } from './server/runtime/policies'
export { currentSession } from './server/runtime/session'
export { type Cipher, Vault, type VaultAdapter } from './server/runtime/vault'
export * as query from './server/store/query'
export { allTables, schemaSql } from './server/store/schema-sql'
export { placeholders, type Sql } from './server/store/sql'
export { type RunSql, sqlBackend, sqlStore } from './server/store/sql-store'
export {
  type Backend,
  callbackTransaction,
  makeStore,
  type RawQuery,
  Store,
  type StoreAdapter,
  type StoreShape,
  type Transact,
  TransactionFailed,
} from './server/store/store'
export * as table from './server/store/table'
export type { AnyTable, Column, Kind, Table } from './server/store/table'
