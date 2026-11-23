import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { crmHandler } from './runtime/boundary'
import { mailboxStatus, syncMine } from './sync'

/** The signed-in teammate's Google and Microsoft accounts, and what the CRM can do with each. */
export const mailboxStatusFn = createServerFn({ method: 'GET' }).handler(
  crmHandler('mailbox.status', ({ user }) =>
    Effect.map(mailboxStatus(user), (accounts) => ({ accounts })),
  ),
)

/** Read the teammate's own mailbox and calendar now. */
export const syncMailboxFn = createServerFn({ method: 'POST' }).handler(
  crmHandler('mailbox.syncMine', ({ user }) => syncMine(user)),
)
