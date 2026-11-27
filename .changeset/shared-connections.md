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
  and `getAccessToken(id, { as })` takes the person the call is for. Both refuse someone who
  is not on the access list, their own connections included, and a personal connection to
  anyone but its owner. When the person named is nobody (`as: ctx.actor` or
  `usableBy: ctx.actor` in a handler that ran with no one signed in), `getAccessToken`
  refuses and `findConnections` finds nothing: a missing actor is never taken to mean
  "trusted". Code nobody is behind stays trusted by naming no person at all, exactly as
  before this release: `getAccessToken(id)` and `findConnections` without `usableBy`.
  `findConnections({ userId })` now means that teammate's own connections: it no longer
  returns one they connected for the team.
- **Which account was connected comes from the provider.** A provider's `account` should ask
  the provider with `get`, which uses the token just issued. The callback's query string
  passes through the browser, so for a shared provider a connection whose `account` did not
  get an answer through `get` is refused. If yours reads `query.get(...)` and you add
  `shared`, have it confirm that value with `get` (docs/integrations.md, "Add a provider").
  Providers that are each person's own are not refused, but should do the same.
- **One connection for each shared account.** Two people connecting the same account for
  the team at once now make one connection, not two, and a token renewed while its
  connection was being connected again or handed to the team no longer overwrites the new
  one.
- **Disconnecting** no longer asks the provider to revoke the token while another connection
  holds the same account at the same OAuth client: at many providers that ended the other
  connection's access too. The stored tokens are deleted either way, and the last connection
  to an account is revoked as before.
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
  disconnect one, where only whoever connected it could before. To limit that, set
  `marketing.canManage` in `src/app/extensions.ts` (email addresses or a function, as
  `canManage` on a provider): only those people may then connect and disconnect the
  built-in networks' accounts, and everyone still publishes through them.

**The tables change.** `integrations` gains `shared`, `group_key` (both default to empty),
`connected_by_name`, `connected_at` and `owner_key`. Its unique set becomes user, provider,
account, shared, group, and `owner_key` is unique on its own: it is filled in on a shared
connection (provider, account, and the team or which group) and empty on a personal one, so
there is one row per shared account whoever connected it and one per person otherwise. Run
`bun run crm:gen` then `bun run db:push` (or `db:plan` and `db:migrate` in production). No
row needs rewriting: a row stored before is a personal connection as it stands, and a
marketing account connected before gets its `owner_key` the next time it is connected. If
two teammates had each connected the same marketing account, both rows keep working until
then, and connecting it again leaves one.

**PGlite data directories upgrade by themselves.** PGlite's schema step now drops an index
its table no longer declares, as well as adding what is missing. Before, a `.data/pglite`
made by an earlier version kept the old unique index on user, provider and account, and
anything the new rules allow but the old index did not failed with a database error:
reconnecting a team account when you also hold that account as your own, or connecting one
account for two groups. There is nothing to delete. An index you added to a PGlite table by
hand is dropped too, since the table does not declare it; tables and columns are never
dropped.

No new route files: `?group=` is read by the connect route you already have.
