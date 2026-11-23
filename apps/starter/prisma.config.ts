import { definePrismaConfig } from '@prisma/cli-engine'
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'

// Bun loads .env automatically. Use the Supabase *direct* or *session pooler*
// connection string here (migrations need a session, not the transaction pooler).
export default definePrismaConfig({
  orm: ormConfig({
    contract: './prisma/schema.prisma',
    db: {
      connection: process.env['DATABASE_URL'] ?? '',
    },
  }),
})
