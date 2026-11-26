# Security

Each deployment of a Spool serves one business. This page says who can do what in one, and
what to know before putting customer data in it. A business whose groups (branches, regions,
teams) must each see only their own records turns on [record scopes](#record-scopes). To report a vulnerability, see the
[security policy](../SECURITY.md).

## Trust model

These are the boundaries the code enforces:

| Who                                       | Can do                                                                                                                 | Enforced by                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone                                    | See the sign-in page, unsubscribe with a valid signed link                                                             | The only public routes; the unsubscribe token is signed with `APP_SECRET`                                                                                  |
| Signed-in person **not** on the allowlist | Nothing in the CRM                                                                                                     | The boundary checks a _verified_ email against `access` in `crm.config.json`. An auth adapter hands over an address only when its provider has verified it |
| CRM user                                  | Read and write every record, run actions, use the assistant                                                            | Every CRM server function and API route goes through the boundary (`crmHandler`, `apiRoute`); lint refuses one that doesn't                                |
| Swirls (workflows, assistant tools)       | Call `/api/swirls/tools/*`                                                                                             | Bearer `SWIRLS_APP_TOKEN` (32+ chars, constant-time compare). Fails closed when unset                                                                      |
| A cron job                                | Run one pass of the mailbox sync, the sequences or the scheduled posts, or keep the server warm, through `/api/cron/*` | Bearer `CRON_SECRET` (16+ chars, constant-time compare). Fails closed when unset                                                                           |
| The email provider                        | Report bounces and complaints to `/api/webhooks/email`                                                                 | The email adapter checks the signature (Resend: Svix, with `RESEND_WEBHOOK_SECRET`). Refused when no secret is set                                         |

Without `scopes` in `crm.config.json`, every allowed user has the same access: they read and
write every record. With it, see [Record scopes](#record-scopes). Use separate deployments if
you need the separation a database gives.

## Record scopes

With [`scopes`](configuration.md#scopes) in the config, each record of a scoped object belongs
to one scope, and a person reaches only the scopes they hold.

| Who                                            | Can do                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A person who holds a scope with a writing role | Read and change that scope's records, and what hangs off them: timeline, tasks, notes, files, sequence runs |
| A person who holds it with a read-only role    | Read them. Any change is refused                                                                            |
| A person whose role has `all`                  | The same, in every scope                                                                                    |
| A person on the access list who holds nothing  | Shared objects only. They see no scoped record and nobody on the team list                                  |
| A workflow calling the tool API                | What its signed grant says: the scope of the record it was started for. With no grant, no scoped record     |
| A cron job, a webhook, a script                | Nothing scoped, unless the code that runs says it is the system (`asSystem`)                                |

**Where it is kept.** In one place, under everything: every store is behind a guard
(`packages/spools/src/server/store/scope.ts`) that narrows each read, count, change and delete
to the scopes of whoever the request is for. Pages, search, reports, exports, imports, saved
views, the assistant's tools and your own extensions all reach the database through it, on
every database adapter. A record of another scope is not found; it is never "forbidden". With
nobody said, a scoped table refuses the call, so new code that forgets fails closed.

**What to know.**

- **The scope a person works in is a preference, not proof.** The `spools-scope` cookie (or
  Clerk's active organization) is checked against what the person holds on every request.
- **Relations stay inside a scope.** A record can't point at a scoped record of another scope,
  and can't move to another scope while scoped records point at it: move or unlink those
  first. Its timeline, tasks, notes, folder and sequence runs move with it.
- **Records that crossed before scopes were turned on.** A relation that already pointed
  into another scope is left as it is. The related record's title is not shown, and filters
  can't ask about it, but the row keeps the related record's id, and a list sorted by that
  relation is still ordered by the title that isn't shown. Clear such relations when you
  turn scopes on.
- **Rows written before scopes were turned on** have no scope and are only there for a role
  with `all`, until `bun run db:scopes` (`spools scopes backfill`) has given them their
  record's. A task or note on no record stays with head office: nothing says whose it was.
- **Owners and assignees.** A `user` field can name anyone, including someone who can't open
  the record. The pickers only offer people who share the scope.
- **Saved views are shared by everyone who uses the object**, whatever their scope: a view's
  name and its filters are seen by all. The titles of records a filter names are not.
- **Files.** The file store knows nothing of scopes, so the CRM checks every folder and file
  it is asked about: a record's folder, and everything under it, is only reached by those who
  reach the record. A file is opened, renamed, moved or deleted through the folder it is in
  (the link carries it), never by its id alone. Anyone with access to the store itself still
  reads all of it. The shared library, and folders the team made outside a record's folder,
  are everyone's.
- **The assistant.** Its chats must be each person's own, which needs federation with your
  sign-in provider: with a project API key everyone would read everyone's chats, so the
  assistant is refused and says so. And the assistant's record tools are refused in chat,
  because a chat has no way to carry a grant that the model can't relay; see
  [Swirls](swirls.md#record-scopes). Workflows started from a record do carry one.
- **Marketing, integrations and guides** are not scoped: the Marketing page and its posts
  are the whole business's.
- **Read-only people still see edit controls.** The server refuses the change and says why.
- **Only PGlite has been run** with scopes. The guard is the same code for every adapter,
  but run the integration tests on your database (`TEST_STORE`) before relying on it.

## Things to know

- **The development parts don't run in production.** A copy with no keys uses a database
  inside the server and a sign-in that lets everyone in. In a build both are left out:
  `src/spool.server.ts` picks them only when `NODE_ENV` isn't `production`, which a build
  fixes, and the development sign-in refuses to start under `NODE_ENV=production`. A
  deployment missing its keys stops at start-up.
- **Clerk development instances are for testing.** One verifies any address ending in
  `+clerk_test` for whoever types a fixed code. A deployment never accepts such an address,
  and says at start-up when it is running on a development instance's keys (`sk_test_`). Use
  the production instance's keys where real people sign in.
- **Field encryption isn't active yet.** Fields marked `encrypted` are stored as
  plaintext until `@cipherstash/stack-prisma` supports Prisma 8. Treat the database
  as holding plaintext PII and secure it accordingly.
- **AI sees CRM data.** Swirls workflows and the assistant receive record contents,
  including text that came from outside your team (imports, pasted notes). Treat that
  text as untrusted input to the model. The assistant's tools can only read and modify CRM
  records and add notes, and they can't change email addresses. A record made through the
  tool API starts no automations, so nothing emails an address the model chose. Its replies
  never load an image, so text it read can't have a browser send what it knows to another
  server. Workflows email your team.
- **Mailboxes.** For the account a teammate signs in with, the auth provider holds the
  Google or Microsoft tokens and the CRM asks it for one when it reads or sends. With
  Clerk, access to your Clerk secret key is access to those mailboxes. With Better Auth
  they are in your own database, encrypted with `BETTER_AUTH_SECRET`, so that secret
  together with the database is. Only
  the subject, a short preview and the time of mail involving a known contact are
  stored; message bodies are never fetched. Whose mail it is comes from the address in the
  From header, never the name beside it. Only the mailbox itself says a teammate sent a
  message: Gmail's Sent label, or Microsoft's Sent Items folder. Junk and deleted mail are
  read past. See [docs/mailbox.md](mailbox.md).
- **Connected accounts.** Tokens for accounts connected on the Integrations page
  are sealed by the vault in the app before they are stored; the database
  holds only ciphertext and there is no plaintext fallback. Each is sealed for the row it is
  stored on, and is refused anywhere else, so someone who can write to the database can't
  move one teammate's tokens onto a connection of their own. The vault's keys (`CS_*`, or
  `VAULT_KEY`) together with the database are access to those accounts.
  The OAuth flow uses PKCE and a `state` signed with `APP_SECRET` that names the
  teammate and is tied to their browser by a cookie. A teammate removed from
  `access` keeps their stored tokens until they are deleted, but their mailboxes
  stop being read. See [docs/integrations.md](integrations.md).
- **Marketing.** An account connected for marketing (LinkedIn, X, Google Ads) is the
  one kind of connection that is shared: any CRM user can publish through it from the
  Marketing page, whoever connected it. Its tokens are sealed like any other, and no
  browser is sent one. `META_ACCESS_TOKEN` is a token for the business's page and ad
  account: treat it as you treat the database's password. Only a CRM user can schedule or
  publish a post. The tool API can save a draft and nothing more, so text the assistant
  read can't put a post out. The website check fetches the address in `crm.config.json`
  and no other, and the install code it shows is built only from ids that match their
  vendor's form. See [docs/marketing.md](marketing.md).
- **Files.** The file store's keys stay on the server; a browser is only ever given a
  transfer URL for the one file it is sending, or a five-minute link to the one file it
  is opening, after the CRM session is checked. Anyone who may use the CRM can open,
  rename, move and delete any file, and anyone with access to the store can read all of
  it: folders are not permission boundaries. With FlashDrive the key reaches every drive
  in its workspace. Files the server hands out itself are never run by the browser as a
  page of the CRM. See
  [docs/files.md](files.md).
- **Assistant conversations are shared** across CRM users when using a project API
  key (see [docs/swirls.md](swirls.md#the-assistant)).
- **Secrets.** Every key in `.env.example` is server-only except
  `CLERK_PUBLISHABLE_KEY`, which is meant for the browser. Rotate
  `SWIRLS_APP_TOKEN` in both the app and Swirls together.
- **Cross-site requests.** Server functions and the assistant endpoint reject
  requests that don't come from the app's own origin (`csrfMiddleware` in `src/start.ts`), so another
  site can't act through a signed-in user's session. Keep that middleware first if
  you add your own. Every answer also tells the browser not to show the CRM in another
  site's frame and to take each file as the type it is sent as. Send
  `Strict-Transport-Security` from the proxy in front of the server, which is where HTTPS ends.
- **Supabase Data API.** The app never uses it. `supabase/config.toml` doesn't
  expose `public`. Every generated table has row-level security on with no policies
  (`@@rls` in the Prisma schema), and `bun run db:push` / `db:migrate` run
  `spools harden`, which revokes the `anon` and `authenticated` roles on
  every table and fails if RLS is off anywhere. On hosted Supabase, also remove `public` from Settings →
  API → Exposed schemas.
