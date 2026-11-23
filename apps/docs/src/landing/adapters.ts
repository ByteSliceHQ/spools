/** What a Spool can run on, and the file that says so. Used by the picker on the home page. */

export type Choice = {
  label: string
  /** The line's value in src/spool.server.ts. */
  call: string
  module: string
  names: readonly string[]
  /** Optional packages to install. */
  packages?: readonly string[]
  /** Environment variables it needs. */
  variables?: readonly string[]
  /** Another import the line needs. */
  extraImport?: string
}

export type Port = {
  id: string
  label: string
  choices: readonly Choice[]
  /** A Spool runs without this one; its feature is off. */
  optional?: boolean
}

export const ports = [
  {
    id: 'auth',
    label: 'Sign-in',
    choices: [
      {
        label: 'Clerk',
        call: 'clerk()',
        module: '@swirls/spools/auth/clerk',
        names: ['clerk'],
        packages: ['@clerk/tanstack-react-start'],
        variables: ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'],
      },
      {
        label: 'Better Auth',
        call: 'betterAuth()',
        module: '@swirls/spools/auth/better-auth',
        names: ['betterAuth'],
        packages: ['better-auth'],
        variables: ['BETTER_AUTH_SECRET', 'APP_URL'],
      },
    ],
  },
  {
    id: 'database',
    label: 'Database',
    choices: [
      {
        label: 'Postgres',
        call: 'postgres()',
        module: '@swirls/spools/database/postgres',
        names: ['postgres'],
        packages: ['@effect/sql-pg'],
        variables: ['DATABASE_URL'],
      },
      {
        label: 'PGlite',
        call: 'pglite()',
        module: '@swirls/spools/database/pglite',
        names: ['pglite'],
        packages: ['@effect/sql-pglite', '@electric-sql/pglite'],
      },
      {
        label: 'Prisma',
        call: 'prisma({ contract })',
        module: '@swirls/spools/database/prisma',
        names: ['prisma'],
        packages: ['@prisma/orm-postgres'],
        variables: ['DATABASE_URL'],
        extraImport: "import contract from '../prisma/schema.json' with { type: 'json' }",
      },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    optional: true,
    choices: [
      {
        label: 'S3',
        call: 'drive({ blobs: s3Blobs() })',
        module: '@swirls/spools/files/drive',
        names: ['drive', 's3Blobs'],
        variables: ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
      },
      {
        label: 'Local disk',
        call: 'drive({ blobs: localBlobs() })',
        module: '@swirls/spools/files/drive',
        names: ['drive', 'localBlobs'],
      },
      {
        label: 'FlashDrive',
        call: 'flashdrive()',
        module: '@swirls/spools/files/flashdrive',
        names: ['flashdrive'],
        variables: ['FLASHDRIVE_API_KEY', 'FLASHDRIVE_DRIVE_ID'],
      },
    ],
  },
  {
    id: 'email',
    label: 'Email',
    optional: true,
    choices: [
      {
        label: 'Resend',
        call: 'resend()',
        module: '@swirls/spools/email/resend',
        names: ['resend'],
        packages: ['resend'],
        variables: ['RESEND_API_KEY', 'EMAIL_FROM'],
      },
    ],
  },
  {
    id: 'vault',
    label: 'Vault',
    optional: true,
    choices: [
      {
        label: 'AES',
        call: 'aes()',
        module: '@swirls/spools/vault/aes',
        names: ['aes'],
        variables: ['VAULT_KEY'],
      },
      {
        label: 'CipherStash',
        call: 'cipherstash()',
        module: '@swirls/spools/vault/cipherstash',
        names: ['cipherstash'],
        packages: ['@cipherstash/stack'],
        variables: ['CS_WORKSPACE_CRN', 'CS_CLIENT_ID', 'CS_CLIENT_KEY', 'CS_CLIENT_ACCESS_KEY'],
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    optional: true,
    choices: [
      {
        label: 'Swirls',
        call: 'swirls()',
        module: '@swirls/spools/agents/swirls',
        names: ['swirls'],
        variables: ['SWIRLS_PROJECT_ID'],
      },
    ],
  },
] as const satisfies readonly Port[]

export type PortId = (typeof ports)[number]['id']

/** The chosen adapter of each part, by label. A part left out of the Spool is null. */
export type Selection = Record<PortId, string | null>

export const startingSelection: Selection = {
  auth: 'Clerk',
  database: 'Postgres',
  files: 'S3',
  email: 'Resend',
  vault: 'AES',
  agents: 'Swirls',
}

export function chosen(selection: Selection): { port: Port; choice: Choice }[] {
  return ports.flatMap((port) => {
    const choices: readonly Choice[] = port.choices
    const choice = choices.find(({ label }) => label === selection[port.id])
    return choice ? [{ port, choice }] : []
  })
}

/** src/spool.server.ts for what was chosen. */
export function spoolFile(selection: Selection) {
  const lines = chosen(selection)

  const imports = lines
    .map(({ choice }) => `import { ${choice.names.join(', ')} } from '${choice.module}'`)
    .toSorted((a, b) => a.slice(a.indexOf("'")).localeCompare(b.slice(b.indexOf("'"))))

  const extras = lines.flatMap(({ choice }) => choice.extraImport ?? [])

  return [
    "import { defineSpool } from '@swirls/spools'",
    ...imports,
    "import crm from '../crm.config.json' with { type: 'json' }",
    ...extras,
    "import extensions from './app/extensions'",
    '',
    'export default defineSpool({',
    '  crm,',
    '  extensions,',
    ...lines.map(({ port, choice }) => `  ${port.id}: ${choice.call},`),
    '})',
  ].join('\n')
}

export function packagesFor(selection: Selection) {
  return chosen(selection).flatMap(({ choice }) => choice.packages ?? [])
}

export function variablesFor(selection: Selection) {
  return [...new Set(chosen(selection).flatMap(({ choice }) => choice.variables ?? []))]
}
