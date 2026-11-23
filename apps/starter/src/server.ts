import './spool.server'
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import { serveSpool } from '@swirls/spools/server'

// Custom TanStack Start server entry: runs once when the server boots (dev and prod).
export default createServerEntry(serveSpool(handler))
