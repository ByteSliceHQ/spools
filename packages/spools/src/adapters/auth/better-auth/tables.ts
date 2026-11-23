import {
  type AnyTable,
  boolean,
  createdAt,
  defineTable,
  id,
  optional,
  text,
  timestamp,
  updatedAt,
  withDefault,
} from '../../../server/store/table'

/**
 * What the Better Auth adapter keeps in the Spool's own database. The columns
 * are Better Auth's, under its names (database.ts maps its models onto these),
 * except for two it would have and this adapter leaves out: `password`, because
 * nobody signs in with one, and `idToken`, because nothing needs it once it has
 * been read.
 */

export const AuthUser = defineTable({
  model: 'AuthUser',
  name: 'auth_users',
  doc: `People who sign in. Being here is not permission to use the CRM: the
config's access list decides that, every time.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    name: text({
      doc: 'As Google or Microsoft gave it; empty for someone who has only used links by email.',
    }),
    email: text({ doc: 'Lower-cased.' }),
    emailVerified: withDefault(
      boolean({
        doc: "Whether the address is known to be theirs. The CRM ignores an address that isn't.",
      }),
      false,
    ),
    image: optional(text()),
  },
  unique: [['email']],
  indexes: [['createdAt']],
})

export const AuthSession = defineTable({
  model: 'AuthSession',
  name: 'auth_sessions',
  doc: `Who is signed in. The browser holds the token in a cookie signed with
BETTER_AUTH_SECRET, so a copy of this table alone signs nobody in.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    userId: text(),
    token: text(),
    expiresAt: timestamp(),
    ipAddress: optional(text()),
    userAgent: optional(text()),
  },
  unique: [['token']],
  indexes: [['userId']],
})

export const AuthAccount = defineTable({
  model: 'AuthAccount',
  name: 'auth_accounts',
  doc: 'The Google and Microsoft accounts people sign in with, and what each has let the CRM do.',
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    userId: text(),
    providerId: text({ doc: '"google" or "microsoft".' }),
    accountId: text({ doc: "The provider's own id for the account." }),
    email: optional(text({ doc: "The account's address, lower-cased." })),
    accessToken: optional(text({ doc: 'Encrypted with BETTER_AUTH_SECRET before it gets here.' })),
    refreshToken: optional(text({ doc: 'Encrypted, as the access token is.' })),
    accessTokenExpiresAt: optional(timestamp()),
    refreshTokenExpiresAt: optional(timestamp()),
    scope: optional(text({ doc: 'What the account has granted, separated by commas.' })),
  },
  unique: [['providerId', 'accountId']],
  indexes: [['userId']],
})

export const AuthVerification = defineTable({
  model: 'AuthVerification',
  name: 'auth_verifications',
  doc: `Things waiting to be proven, each for a few minutes: a link sent by email
(as a hash of its token) and a sign-in under way at Google or Microsoft.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    identifier: text(),
    value: text(),
    expiresAt: timestamp(),
  },
  indexes: [['identifier'], ['expiresAt']],
})

export const authTables: readonly AnyTable[] = [
  AuthUser,
  AuthSession,
  AuthAccount,
  AuthVerification,
]
