# Upgrading

The framework is a package, so an update is a version:

```sh
bun update @swirls/spools
bun run crm:gen
bun run db:push                # local; see docs/deployment.md for production
bun run check
```

Read the [changelog](../packages/spools/CHANGELOG.md) first. Breaking changes are listed with what to do
about them. Your own files (`crm.config.json`, `src/`, `swirls/`) never change under you.

## Versioning

- The framework follows semantic versioning. Before 1.0, minor versions can include
  breaking changes.
- `"version"` in `crm.config.json` is the config format version. It changes only when
  the format breaks, and `bun run crm:gen` tells you if your config is on an older one.
- New pages and endpoints are new route files. The changelog gives them to you to copy;
  until you do, the feature is off.

## From a copy of the repository

Before Spools was a package, a CRM was a copy of the whole repository that merged updates from it. Moving
one over changes no data: the tables are the same, column for column, and `crm.config.json`
and every environment variable keep their names.

1. **Make a Spool** in a folder of its own with `bun create @swirls/spools`, and copy what is
   yours over it: `crm.config.json`, `src/app`, `src/styles.css`, `swirls`, `migrations`,
   `.env`, and any pages you added to `src/routes`. Keep your
   repository's history by doing this on a branch of it.
2. **Say what it runs on** in `src/spool.server.ts`. These are the services a copy used, so
   nothing behaves differently:

   ```ts
   export default defineSpool({
     crm,
     extensions,
     auth: clerk(),
     database: prisma({ contract }),
     files: flashdrive(),
     email: resend(),
     vault: cipherstash(),
     agents: swirls(),
   })
   ```

3. **Change your imports.** In `src/app/extensions.ts`, `'../crm/extensions'` and
   `'../server/extension-api'` are both `'@swirls/spools/extensions'`.
4. **Change your own server code** that used the database: it asks for `Store` instead of
   `Database` ([Database](database.md#using-the-store)). `AuthError` replaces `ClerkError` and
   `AgentsError` replaces `SwirlsError`.
5. **Find a home for changes you made to the framework.** Most fit an extension point:
   [hooks, handlers, pages](extending.md), or an [adapter](adapters.md). Open an
   issue for one that doesn't.
6. Run `bun run crm:gen` and `bun run check`. `crm:gen` should leave `prisma/schema.json`
   exactly as it was, which is how you know the database needs no change.

The Resend webhook keeps its address: `/api/webhooks/resend` is now the same as
`/api/webhooks/email`. The stubbed-sign-in harness reads `DEV_AUTH_EMAIL` and
`DEV_AUTH_SIGNED_OUT` where it read `E2E_EMAIL` and `E2E_SIGNED_OUT`.

On a host with no long-lived process, set `SERVERLESS=1`. It used to be worked out from the host.
