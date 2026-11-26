---
'@swirls/spools': minor
---

Record scopes: one Spool for a business whose groups (branches, regions, teams) must each see only their own records. Add `scopes` to `crm.config.json` (the scope field of each scoped object, and the roles a scope is held with) and say who holds what with `clerk({ scopes: 'organizations' })`, `devAuth({ scopes })` or `scopes` in `src/app/extensions.ts`. Every store is then behind a guard that narrows each read, count, change and delete to the scopes of whoever the request is for, so pages, search, reports, exports, imports, the tool API and extensions all keep to it. A Spool without `scopes` is unchanged.

For everyone, with or without scopes: seven system tables (`activities`, `tasks`, `notes`, `favorites`, `record_folders`, `file_uploads`, `sequence_runs`) gain a nullable `scope` column. Run `bun run crm:gen` and `bun run db:push` (or plan and apply a migration). Nothing else changes until you add `scopes`.

Turning scopes on: give every record of a scoped object its scope, then run `spools scopes backfill` (add `"db:scopes": "spools scopes backfill"` to your scripts) so rows written before take their record's scope. Workflows that write back through the tool API must send the `grant` from their input as the `X-Spools-Grant` header. The assistant needs federation, and its record tools are refused in chat. See docs/security.md#record-scopes.

Also new: `asSystem` in `@swirls/spools/extensions` for scripts, `@swirls/spools/scopes` (the types), the `spools scopes backfill` command, and `/api/files/<id>?folder=<folder id>`, which the file browser's links now carry.
