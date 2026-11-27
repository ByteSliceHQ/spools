import { definePrismaConfig } from '@prisma/cli-engine'
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'

// The schema of the scoped Spool the scopes-*.test.ts files run on
// (tests/fixtures/scoped.config.json), for the stores that need their tables made
// first. `bun run test:scopes:gen` writes it; tests/support/scoped-database.ts
// pushes it to a database of the tests' own.
export default definePrismaConfig({
  orm: ormConfig({
    contract: './prisma/schema.prisma',
    db: {
      connection: process.env['DATABASE_URL'] ?? '',
    },
  }),
})
