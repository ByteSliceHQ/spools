import { definePrismaConfig } from '@prisma/cli-engine'
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'

// The relations fixture's own Prisma project. `bun run db:push:relations` writes
// prisma/schema.prisma from ../relations.config.json, emits the contract beside it
// and pushes it to the fixture's database (tests/support/relations-database.ts).
export default definePrismaConfig({
  orm: ormConfig({
    contract: './prisma/schema.prisma',
    db: {
      connection: process.env['DATABASE_URL'] ?? '',
    },
  }),
})
