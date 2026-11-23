import { Link } from '@tanstack/react-router'
import { Check, Minus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { mailboxStatusFn, syncMailboxFn } from '../../server/mailbox.functions'
import { requestedScopes } from '../mailbox'
import { useAuth } from './auth'
import { Button, Dialog, relativeTime } from './kit'

type Status = Awaited<ReturnType<typeof mailboxStatusFn>>['accounts'][number]

/**
 * What the CRM can do with the teammate's mailboxes: the Google or Microsoft
 * account they sign in with, and any they connected on the Integrations page.
 * Missing permissions on the sign-in are granted from the person's profile; other
 * mailboxes are connected, reconnected and removed on the Integrations page.
 */
export function MailboxDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const openAccount = useAuth().useOpenAccount()
  const [accounts, setAccounts] = useState<Status[]>()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>()
  const [error, setError] = useState<string>()

  const load = () =>
    mailboxStatusFn()
      .then((r) => setAccounts(r.accounts))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load your mailbox'))

  // Load once each time the dialog opens.
  useEffect(() => {
    if (!open) {
      return
    }

    setNote(undefined)
    setError(undefined)
    void load()
  }, [open])

  // Only the sign-in is fixed from the profile; a connected mailbox is fixed on the Integrations page.
  const missing =
    accounts?.some((a) => a.connectionId === null && (!a.canRead || !a.canSend)) ?? false

  const readable = accounts?.some((a) => a.canRead) ?? false

  return (
    <Dialog open={open} onClose={onClose} title="Your mailbox">
      <div className="space-y-4">
        {accounts === undefined && !error && <p className="text-c-fg2">Loading…</p>}

        {accounts?.length === 0 && (
          <p className="text-c-fg2">
            You didn't sign in with Google or Microsoft and haven't connected a mailbox, so there is
            none for the CRM to read or send from. Emails you write here go out through the shared
            address.
          </p>
        )}

        {accounts?.map((a) => (
          <div
            key={`${a.provider}:${a.accountEmail}`}
            className="border-c-line rounded-xl border p-3"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{a.label}</span>
              <span className="text-c-fg2 min-w-0 flex-1 truncate">{a.accountEmail}</span>
              <span className="text-c-fg3 text-[12px]">
                {a.connectionId === null ? 'Sign-in' : 'Connected'}
              </span>
            </div>
            {a.needsReconnect ? (
              <p className="mt-2 text-red-600">Needs reconnecting on the Integrations page.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                <Grant
                  ok={a.canRead}
                  yes="Mail and meetings with your contacts are logged on their timelines"
                  no="No access to read this mail and calendar yet"
                />
                <Grant
                  ok={a.canSend}
                  yes="You can send emails from this mailbox"
                  no="No access to send from this mailbox yet"
                />
              </ul>
            )}
            {a.canRead && (
              <p className="text-c-fg3 mt-2 text-[12px]">
                {a.syncing
                  ? 'Reading now…'
                  : a.lastSyncedAt
                    ? `Last read ${relativeTime(a.lastSyncedAt)}`
                    : 'Not read yet'}
              </p>
            )}
            {a.lastError && <p className="mt-2 text-[12px] text-red-600">{a.lastError}</p>}
          </div>
        ))}

        {missing && (
          <p className="text-c-fg2">
            Some access hasn't been granted. Open your profile, reconnect the account and accept the
            extra permissions.
          </p>
        )}
        {accounts !== undefined && (
          <p className="text-c-fg2">
            Use another address too?{' '}
            <Link to="/integrations" onClick={onClose} className="text-c-accent hover:underline">
              Connect a mailbox
            </Link>
            .
          </p>
        )}
        {note && <p className="text-c-fg2">{note}</p>}
        {error && <p className="text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{missing ? 'Close' : 'Done'}</Button>
          {readable && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setNote(undefined)
                setError(undefined)

                try {
                  const result = await syncMailboxFn()

                  setNote(
                    result.problem ??
                      `Logged ${result.emails} ${result.emails === 1 ? 'email' : 'emails'} and ${result.meetings} ${
                        result.meetings === 1 ? 'meeting' : 'meetings'
                      }.`,
                  )

                  await load()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not read your mailbox')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Reading…' : 'Read now'}
            </Button>
          )}
          {missing && openAccount && (
            <Button
              variant="primary"
              onClick={() => {
                onClose()
                openAccount({ scopes: requestedScopes() })
              }}
            >
              Open profile
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export function Grant({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
      ) : (
        <Minus className="text-c-fg3 mt-0.5 size-3.5 shrink-0" />
      )}
      <span className={ok ? undefined : 'text-c-fg3'}>{ok ? yes : no}</span>
    </li>
  )
}
