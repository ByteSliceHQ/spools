---
'@swirls/spools': minor
'@swirls/create-spools': minor
---

A connection on the Integrations page can belong to the team, or to one group of it, instead
of to the teammate who connected it.

- **`shared` on an integration provider.** In `integrations` in `src/app/extensions.ts`,
  `shared: 'team'` makes a provider's connections everyone's (one accounting system for the
  company), and `shared: 'group'` with `groups` makes each one a group's, chosen when it is
  connected (one per branch or region). Left out, a connection is its teammate's own, as
  before. `canManage`, a list of email addresses or a function, limits who may connect,
  reconnect and disconnect a shared one; without it anyone on the access list may.
- **Using one.** `findConnections` takes `shared: 'team'`, `group: '<key>'` and `usableBy`,
  and `getAccessToken(id, { as })` takes the person the call is for. Both refuse a shared
  connection to someone who is not on the access list, and a personal one to anyone but its
  owner. Without `usableBy` or `as` they are trusted, as before.
  `findConnections({ userId })` now means that teammate's own connections: it no longer
  returns one they connected for the team.
- **The page.** Shared connections are listed for everyone under "Shared with the team":
  the account, the whole team or which group, who connected it and when, and whether it
  needs reconnecting. Reconnect and Disconnect are for the people who may manage it.
- **After someone leaves.** A shared connection keeps working, and stays listed with their
  name, when whoever connected it is removed from the access list. A connected mailbox still
  stops being read, as before: the built-in Google and Microsoft mailboxes can't be shared.
- **The OAuth `state`** carries whose the connection will be, and the callback takes it from
  there alone. A shared connection's tokens are sealed for a name that includes its kind and
  group. A connection of one's own is signed and sealed exactly as it was.
- **Marketing accounts** (LinkedIn, X, Google Ads) are shared connections now. Publishing is
  unchanged, and accounts already connected keep working without being touched. What changes:
  every teammate sees them on the Integrations page, and any teammate can reconnect or
  disconnect one, where only whoever connected it could before.

**The tables change.** `integrations` gains `shared`, `group_key` (both default to empty),
`connected_by_name` and `connected_at`, and its unique set becomes user, provider, account,
shared, group. Run `bun run crm:gen` then `bun run db:push` (or `db:plan` and `db:migrate` in
production). No row needs rewriting: a row stored before is a personal connection as it
stands. PGlite adds the columns by itself but never drops an index, so a development
database made before this keeps the old unique index, which stops one person from holding
the same account for two groups: delete `.data/pglite` to start clean.

No new route files: `?group=` is read by the connect route you already have.
