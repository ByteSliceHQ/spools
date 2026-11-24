# @swirls/spools

## 0.1.0

### Minor Changes

- 356e76b: First release of Spools. `defineSpool` puts a CRM together from a config,
  your own code and the services it runs on: auth (Clerk, Better Auth, a development
  sign-in), database (any Postgres, PGlite, Prisma 8), files (your database with local
  disk or S3, FlashDrive), email (Resend), vault (CipherStash, AES-256-GCM) and agents
  (Swirls). `bun create @swirls/spools` makes a new one.

### Patch Changes

- 356e76b: Fixes from a security and correctness review before the first release.

  - The assistant's replies never load an image, which text it had read could use to send
    CRM data to another server. Every answer now carries headers that keep the CRM out of
    another site's frame.
  - A deployment never accepts one of Clerk's test addresses (`+clerk_test`), which a
    development instance verifies for anybody, and says at start-up when it runs on a
    development instance's keys.
  - Mail sync reads whose mail it is from the address in the From header, never the name
    beside it, and with Gmail only the Sent label says a teammate sent a message.
  - Someone who isn't signed in is never shown the database's own error text.
  - A CSV import reports a bad row and carries on with the rest. It used to stop at the
    first one.
  - Sequence email is not sent without `APP_URL`. It used to go out with an unsubscribe
    link to `localhost`. **To do:** set `APP_URL` to the CRM's public address.
  - `{{field}}` in a sequence email shows a related record by its title, a choice by its
    label and a date as a date.
  - `SERVERLESS` is on only as `1` or `true`. `SERVERLESS=0` used to switch the built-in
    schedules off.
  - Running `spools init` again keeps everyone already on the access list.
  - The lint rules a new Spool ships with follow imports, so a server function or route
    can't skip the session check under another name, and they cover every file in
    `src/routes`, not only `src/routes/api`. **To do in an existing Spool:** in
    `.oxlintrc.json`, change the files of `spools/route-adapters` to `src/routes/**`.
  - `bun run check` in a new Spool no longer needs the Swirls CLI. Run `bun run swirls:check`
    after editing a `.swirls` file.
  - Creating, changing and deleting a record are each one transaction: a record is never
    saved without its line on the timeline, and two changes to one record happen one after
    the other. The store has `transaction` and `lock`. **To do in a database adapter of your
    own:** `sqlBackend` takes a second argument that runs a program as a transaction
    (`callbackTransaction` makes one from a driver's `begin`), and a `Backend` has
    `transaction` and `lock`.
  - An `after` hook runs once the change is kept. If it throws, the change stays and staff
    see "Saved, but a step after it failed".
  - A connected account's tokens are sealed for the row they are stored on and refused
    anywhere else. Tokens stored before this are tied to their row the first time they are
    used. `Vault.seal` and `Vault.open` take the owner, and `open` takes the shape expected.
  - A record made through the tool API (the assistant, a workflow) starts no automations.
  - With Microsoft, only the Sent Items folder says a teammate sent a message, and junk and
    deleted mail are read past.
  - The lint rules that were off for the framework are on, and its type assertions are gone
    but for four at the edge of a driver or a public contract, each with its reason beside it.
  - Browser tests (`bun run test:e2e`), and tests for the Swirls, Clerk and CipherStash
    adapters, the command-line tools and the scaffolder.

- 7166a65: Someone who is signed in but not on the access list gets the "no access" page with a 403.
  It used to come with a 500, which read as a fault of the server's.
