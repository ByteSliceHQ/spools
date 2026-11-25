# Security

Each deployment of a Spool serves one business. This page says who can do what in one, and
what to know before putting customer data in it. To report a vulnerability, see the
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

There are no per-user roles inside the CRM: every allowed user has the same access.
Use separate deployments if you need hard separation.

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
