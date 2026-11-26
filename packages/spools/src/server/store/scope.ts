import { Context } from 'effect'

import type { ScopeAccess } from '../../crm/scopes'
import type { StoreShape } from './store'

/**
 * Record scopes, where they are enforced: between every caller and every
 * database (src/crm/scopes.ts says what a scope is). `makeStore` puts each
 * store it makes behind `guard`, so the rule holds for every adapter, and for
 * code that reaches the store without going through records.ts or service.ts
 * (views, workspace, search, campaigns, files, an adapter's own tables).
 *
 * STATUS: design checkpoint. `guard` gives the store back as it is; the tests
 * in tests/integration/scopes-*.test.ts say what it has to do:
 *
 * - a table that says it is scoped (an object named in `scopes.objects`, and
 *   the system tables that hang off a record) only shows, counts, changes,
 *   deletes and holds the rows `CurrentAccess` can read or write;
 * - a condition that reaches another table (`some`, `none`) is narrowed on that
 *   table too, and a related record `include` brings back is left out when it
 *   is out of reach;
 * - a new row takes the active scope, a row that hangs off a record takes that
 *   record's, and a scope that isn't held is refused whoever sends it;
 * - with scopes on and no access set, a scoped table refuses the call: work
 *   with nobody signed in must say it is the system's (`asSystem`).
 */

/**
 * What the program running may reach. Null means nobody said: nothing is
 * narrowed in a Spool without scopes, and a scoped table refuses the call in a
 * Spool with them. Set by the boundary for a signed-in person, by the tool
 * route from a signed grant, and by `asSystem` for the server's own work
 * (src/server/scopes.ts).
 */
export const CurrentAccess = Context.Reference<ScopeAccess | null>('spools/Store/access', {
  defaultValue: () => null,
})

/**
 * Whether `guard` keeps to scopes yet. While it doesn't, a server whose config
 * has `scopes` refuses to start (src/server/entry.ts): it would show every
 * record to everyone while its config says otherwise.
 */
export const SCOPES_ENFORCED: boolean = false

/** A store that keeps to `CurrentAccess`. Not enforced yet: this is the store it was given. */
export const guard = (store: StoreShape): StoreShape => store
