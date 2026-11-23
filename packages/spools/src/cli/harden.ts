#!/usr/bin/env bun
/**
 * Lock the CRM tables away from Supabase's Data API (PostgREST).
 *
 * Supabase exposes the `public` schema over HTTP to anyone holding the project's
 * anon key, which is public by design. The app reaches Postgres directly as a
 * privileged role (which bypasses RLS), so the API roles need no access at all:
 * revoke their privileges on every table. Row-level security itself is declared in
 * the Prisma schema (`@@rls` on every model, no policies), so Prisma keeps it on;
 * this script covers the privileges Prisma doesn't manage and verifies RLS.
 *
 * Runs after `db:push` and `db:migrate`. Idempotent.
 */
import { SQL } from 'bun'

const url = process.env['DATABASE_URL']

if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const sql = new SQL(url)
const apiRoles = ['anon', 'authenticated']

try {
  const roles: { rolname: string }[] =
    await sql`select rolname from pg_roles where rolname in ${sql(apiRoles)}`

  const tables: { schemaname: string; tablename: string }[] = await sql`
    select schemaname, tablename from pg_tables where schemaname = 'public'
  `

  for (const { schemaname, tablename } of tables) {
    const ident = `"${schemaname}"."${tablename.replaceAll('"', '""')}"`

    for (const { rolname } of roles) {
      await sql.unsafe(`revoke all on table ${ident} from ${rolname}`)
    }
  }

  // Tables created later in public shouldn't be granted to the API roles by default.
  for (const { rolname } of roles) {
    await sql.unsafe(
      `alter default privileges in schema public revoke all on tables from ${rolname}`,
    )
  }

  const exposed: { tablename: string }[] = await sql`
    select tablename from pg_tables where schemaname = 'public' and not rowsecurity
  `

  if (exposed.length > 0) {
    console.error(
      `✘ Row-level security is OFF on: ${exposed.map((t) => t.tablename).join(', ')}. Run \`bun run crm:gen\` and push again.`,
    )

    process.exit(1)
  }

  console.log(
    `✓ RLS on for all ${tables.length} table(s) in public` +
      (roles.length
        ? `; revoked access for ${roles.map((r) => r.rolname).join(', ')}`
        : ' (no Supabase API roles found)'),
  )
} finally {
  await sql.close()
}
