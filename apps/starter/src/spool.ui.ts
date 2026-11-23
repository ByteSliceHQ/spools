import { clerkClient } from '@swirls/spools/auth/clerk/ui'
import { devAuthClient } from '@swirls/spools/auth/dev/ui'

/** The browser halves of the auth adapters spool.server.ts may choose. The page uses the one the server chose. */
export const authClients = [clerkClient, devAuthClient]
