# Deployment

The app is one Bun server: the CRM, the API routes and the campaign
runtime. Any host that runs a Docker image works (Fly.io,
Railway, Render, a VM).

## 1. Database (Supabase)

1. Create a Supabase project.
2. Copy the **session pooler** connection string (Project Settings → Database). The
   app keeps long-lived connections; the transaction pooler isn't needed.
3. Apply the schema:

   ```sh
   bun run db:plan -- --name initial          # writes migrations/ (commit it)
   DATABASE_URL=<prod url> bun run db:migrate
   ```

   For later changes, edit `crm.config.json`, then `bun run crm:gen`,
   `bun run db:plan -- --name <change>`, commit, and run `db:migrate` against
   production. Prisma refuses destructive changes unless you pass explicit
   `--delete` or `--rename` decisions: `--delete Deal.budget` to drop a field,
   `--rename Deal.proposalAmount:Deal.contractAmount` to keep its data under a
   new name.

   `db:plan` starts from the `db` ref (`migrations/app/refs/db.json`), which
   `bun run db:push` moves forward. If you applied the last migration to your
   local database with `db:migrate` instead, the ref is still one migration
   behind, and the new plan branches off the old one; `db:migrate` then refuses
   it with `MIGRATION.PATH_UNREACHABLE`. Plan from the last migration and move
   the ref yourself:

   ```sh
   bun run db:plan -- --name <change> --from <last migration's folder name>
   bun run db:migrate                                    # your local database
   bun --bun x prisma migration ref set db <the new marker hash db:migrate printed>
   ```

   Commit `refs/db.json` with the migration.

## 2. Signing in

This is for `auth: clerk()`. [Signing in](auth.md) covers the other choices.

Create a production instance, add your domain, and copy its keys. Under
Restrictions, limit sign-ups to your team (the CRM also enforces
`access` from `crm.config.json`).

## 3. Environment

Set what your adapters need from [`.env.example`](../apps/starter/.env.example). At minimum
`DATABASE_URL`, your auth provider's keys, `APP_URL` and `APP_SECRET`. The server logs which optional
features are on at startup, and refuses to start in production without the
required variables.

## 4. Run the image

```sh
docker build -t my-crm .
docker run -p 3000:3000 --env-file .env.production my-crm
```

Health check: `GET /healthz`.

Fly.io example:

```sh
fly launch --no-deploy
fly secrets import < .env.production
fly deploy
```

Any number of instances can run: what is due is kept in the database, and two of them
never send the same email (see [Campaigns](campaigns.md#operations)).

Without Docker:

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

## Vercel

A Spool also deploys to Vercel with the TanStack Start preset (`vercel.json`). Vercel's
preset needs the app packaged by Nitro, so `vite.config.ts` calls `vercel()` from
`@swirls/spools/vite`. On Vercel, where `VERCEL` is set, it emits a Bun function in
`.vercel/output`. Every other build is the `dist/` server above. Set the environment
variables on the Vercel project before the first deploy.

`vercel()` copies the CipherStash packages into the function whole, because they are
native. Name a native package of your own with `vercel({ traceDeps: ['my-native*'] })`.

A function is not a long-lived server, and the framework knows it is on Vercel without
`SERVERLESS=1`. The timers are off and cron jobs call the routes in the next section
instead:

- **Campaigns.** The `vercel.json` here calls `/api/cron/sequences` every ten minutes. It
  needs `CRON_SECRET`, which Vercel Cron sends as a bearer token. Without it only emails
  with no wait are sent, and the Workflows page says so. See
  [Campaigns](campaigns.md#operations).
- **Mailbox sync and scheduled posts.** Add `/api/cron/mail-sync` and `/api/cron/marketing`
  to `crons` in `vercel.json` if you use them. They are left out of the starter's, because
  a schedule your Vercel plan doesn't allow fails the deployment.
- **Cold starts.** Vercel puts an idle function away after a couple of minutes, and the
  next request then waits for it to start again (around three seconds for this app). A CRM
  with a handful of users is idle most of the time, so keep one instance ready with a cron
  job that calls `/api/cron/warm` every minute:

  ```json
  { "crons": [{ "path": "/api/cron/warm", "schedule": "* * * * *" }] }
  ```

  A schedule this frequent needs a paid Vercel plan.

`bun run build` checks the browser files Vercel serves (`.vercel/output/static`) for server
code, as it checks `dist/client` everywhere else.

## A host with no long-lived process

On any other such host, set `SERVERLESS=1`. The server then keeps no timers, and cron jobs
call these instead, with `CRON_SECRET` as a bearer token:

| Route                 | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `/api/cron/sequences` | Sends the sequence emails that are due. See [Campaigns](campaigns.md#operations)          |
| `/api/cron/mail-sync` | Reads teammates' mailboxes. See [Mailbox](mailbox.md#the-schedule)                        |
| `/api/cron/marketing` | Publishes the scheduled posts that are due. See [Marketing](marketing.md#scheduled-posts) |
| `/api/cron/warm`      | Does one small database read, to keep an instance from going cold                         |

Files need [a bucket or FlashDrive](files.md), because `localBlobs()` needs a disk that lasts.

## 5. Swirls

Deploy `swirls/` and set its secrets (see [Swirls](swirls.md)), with
`crm_app::CRM_APP_URL` set to your `APP_URL`.

## Checklist

- [ ] `bun run db:migrate` (or `bun run db:harden`) has run, so RLS is on and the Supabase API roles have no access
- [ ] Supabase → Settings → API → Exposed schemas doesn't include `public`
- [ ] `TRUST_PROXY` matches the number of proxies in front of the app
- [ ] `access` in `crm.config.json` lists your domain or emails
- [ ] Sign-ups restricted at your auth provider
- [ ] `APP_SECRET` and `SWIRLS_APP_TOKEN` are 32+ random characters, unique per environment
- [ ] On Vercel or another serverless host: `CRON_SECRET` set and cron jobs for `/api/cron/sequences`, `/api/cron/mail-sync` and, if you schedule posts, `/api/cron/marketing`
- [ ] Email domain verified and the delivery webhook (`/api/webhooks/email`) configured
- [ ] Supabase backups enabled
