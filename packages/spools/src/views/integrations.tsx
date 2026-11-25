import { getRouteApi, useRouter } from '@tanstack/react-router'
import { Check, Lock, Plug, RefreshCw, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { requestedScopes } from '../crm/mailbox'
import { useAuth } from '../crm/ui/auth'
import { Button, cx, relativeTime } from '../crm/ui/kit'
import { Grant } from '../crm/ui/mailbox'
import { TopBar } from '../crm/ui/shell'
import { disconnectIntegrationFn, type listIntegrationsFn } from '../server/integrations.functions'
import { syncMailboxFn } from '../server/mailbox.functions'

const route = getRouteApi('/_crm/integrations')

type Data = Awaited<ReturnType<typeof listIntegrationsFn>>
type Provider = Data['providers'][number]
type Connection = Data['connections'][number]
type Mailbox = Data['mailboxes'][number]

const marks = new Map([
  ['google', 'bg-blue-500/15 text-blue-600 dark:text-blue-400'],
  ['microsoft', 'bg-teal-500/15 text-teal-600 dark:text-teal-400'],
])

function Mark({ id, label }: { id: string; label: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-lg font-semibold',
        marks.get(id) ?? 'bg-c-hov text-c-fg2',
      )}
    >
      {label.charAt(0).toUpperCase()}
    </span>
  )
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="bg-c-hov text-c-fg2 rounded-md px-1.5 py-0.5 text-[11px]">{children}</span>
  )
}

/** A full navigation, not a fetch: the browser has to leave for the provider's consent screen. */
function ConnectLink({ provider, children }: { provider: string; children: ReactNode }) {
  return (
    <a
      href={`/api/integrations/${provider}/connect`}
      className="bg-c-accent hover:bg-c-accent-hov flex h-7 items-center rounded-lg px-2.5 font-medium text-white"
    >
      {children}
    </a>
  )
}

function Disconnect({ id, account, what }: { id: string; account: string; what: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <>
      {error && <span className="text-c-danger">{error}</span>}
      <Button
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(`Disconnect ${account}? ${what}`)) {
            return
          }

          setBusy(true)
          setError(undefined)

          try {
            await disconnectIntegrationFn({ data: { id } })
            await router.invalidate()
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not disconnect')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Disconnecting…' : 'Disconnect'}
      </Button>
    </>
  )
}

function MailboxCard({ mailbox, canConnect }: { mailbox: Mailbox; canConnect: boolean }) {
  const openAccount = useAuth().useOpenAccount()
  const signIn = mailbox.connectionId === null
  const missing = !mailbox.canRead || !mailbox.canSend
  return (
    <li className="border-c-line bg-c-raised rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <Mark id={mailbox.provider} label={mailbox.label} />
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{mailbox.accountEmail}</span>
            <Tag>{signIn ? `${mailbox.label} sign-in` : `Connected ${mailbox.label} mailbox`}</Tag>
          </h3>
          {mailbox.needsReconnect ? (
            <p className="text-c-danger mt-2 flex items-center gap-1">
              <TriangleAlert className="size-3.5" /> Needs reconnecting
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              <Grant
                ok={mailbox.canRead}
                yes="Mail and meetings with your contacts are logged on their timelines"
                no="No access to read this mail and calendar yet"
              />
              <Grant
                ok={mailbox.canSend}
                yes="You can send emails from this mailbox"
                no="No access to send from this mailbox yet"
              />
            </ul>
          )}
          {mailbox.canRead && (
            <p className="text-c-fg3 mt-2 text-[12px]">
              {mailbox.syncing
                ? 'Reading now…'
                : mailbox.lastSyncedAt
                  ? `Last read ${relativeTime(mailbox.lastSyncedAt)}`
                  : 'Not read yet'}
            </p>
          )}
          {mailbox.lastError && (
            <p className="text-c-danger mt-2 text-[12px]">{mailbox.lastError}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {signIn && missing && openAccount && (
            <Button onClick={() => openAccount({ scopes: requestedScopes() })}>Open profile</Button>
          )}
          {!signIn && (mailbox.needsReconnect || missing) && canConnect && (
            <ConnectLink provider={mailbox.provider}>Reconnect</ConnectLink>
          )}
          {mailbox.connectionId && (
            <Disconnect
              id={mailbox.connectionId}
              account={mailbox.accountEmail}
              what="The CRM will stop reading and sending from this mailbox."
            />
          )}
        </div>
      </div>
    </li>
  )
}

function ConnectionCard({
  connection,
  note,
  reconnect,
}: {
  connection: Connection
  note?: string
  reconnect: boolean
}) {
  return (
    <li className="border-c-line bg-c-raised rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <Mark id={connection.provider} label={connection.label} />
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{connection.account}</span>
            <Tag>{connection.label}</Tag>
          </h3>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {connection.status === 'connected' ? (
              <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                <Check className="size-3.5" /> Connected
              </span>
            ) : (
              <span className="text-c-danger flex items-center gap-1">
                <TriangleAlert className="size-3.5" /> Needs reconnecting
              </span>
            )}
            <span className="text-c-fg3">since {relativeTime(connection.connectedAt)}</span>
          </p>
          {note && <p className="text-c-fg2 mt-1">{note}</p>}
          {connection.lastError && <p className="text-c-danger mt-1">{connection.lastError}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {connection.status === 'error' && reconnect && (
            <ConnectLink provider={connection.provider}>Reconnect</ConnectLink>
          )}
          <Disconnect
            id={connection.id}
            account={connection.account}
            what="The CRM will stop using this account, and its stored tokens are deleted."
          />
        </div>
      </div>
    </li>
  )
}

/** What can be connected: a button per provider that is set up, and a word about the ones that aren't. */
function ConnectRow({
  providers,
  ready,
  verb,
}: {
  providers: Provider[]
  ready: boolean
  verb: string
}) {
  const available = providers.filter((p) => p.available)
  const pending = providers.filter((p) => !p.available)
  return (
    <div className="border-c-line2 rounded-xl border border-dashed p-4">
      <ul className="space-y-3">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center gap-3">
            <Mark id={p.id} label={p.label} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{p.label}</div>
              <div className="text-c-fg2">{p.description}</div>
            </div>
            {ready && p.available && (
              <ConnectLink provider={p.id}>
                {verb} {p.label}
              </ConnectLink>
            )}
          </li>
        ))}
      </ul>
      {ready && pending.length > 0 && (
        <p className="text-c-fg3 mt-3">
          {pending.map((p) => p.label).join(' and ')} {pending.length === 1 ? "hasn't" : "haven't"}{' '}
          been set up for this CRM yet
          {available.length > 0 ? '' : ', so there is nothing to connect'}. Whoever runs the CRM
          adds the client ID and secret to its environment settings.
        </p>
      )}
    </div>
  )
}

export function Integrations(): ReactNode {
  const router = useRouter()
  const { providers, connections, mailboxes, problems } = route.useLoaderData()
  const { connected, error } = route.useSearch()
  const ready = problems.length === 0
  const justConnected = connections.find((c) => c.id === connected)
  const [reading, setReading] = useState(false)
  const [note, setNote] = useState<string>()

  const mailboxProviders = providers.filter((p) => p.mailbox)
  const otherProviders = providers.filter((p) => !p.mailbox)
  const canConnect = (id: string) => ready && providers.some((p) => p.id === id && p.available)

  // A connected mailbox the CRM reaches through the sign-in instead (same address, same access).
  const covered = connections.filter(
    (c) => c.mailbox && !mailboxes.some((m) => m.connectionId === c.id),
  )

  const others = connections.filter((c) => !c.mailbox)

  async function readNow() {
    setReading(true)
    setNote(undefined)

    try {
      const result = await syncMailboxFn()

      setNote(
        result.problem ??
          `Logged ${result.emails} ${result.emails === 1 ? 'email' : 'emails'} and ${result.meetings} ${
            result.meetings === 1 ? 'meeting' : 'meetings'
          }.`,
      )

      await router.invalidate()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not read your mailboxes')
    } finally {
      setReading(false)
    }
  }

  return (
    <>
      <TopBar icon={<Plug className="text-c-fg2 size-3.5" />} title="Integrations" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          <p className="text-c-fg2 px-1">
            The accounts the CRM works with on your behalf. Each person connects their own; nobody
            else can see or use your connections. An account connected for marketing is the
            exception: it says so, and the team publishes through it.
          </p>

          {justConnected && (
            <p
              role="status"
              className="rounded-lg bg-green-500/10 px-3 py-2 text-green-700 dark:text-green-400"
            >
              {justConnected.label} is connected as {justConnected.account}.
            </p>
          )}
          {error && (
            <p role="alert" className="text-c-danger rounded-lg bg-red-500/10 px-3 py-2">
              {error}
            </p>
          )}
          {!ready && (
            <div className="border-c-line bg-c-raised rounded-lg border px-3 py-2.5">
              <p className="font-medium">More accounts can't be connected yet</p>
              <ul className="text-c-fg2 mt-1 list-disc pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="text-c-fg3 mt-1">
                Whoever runs this CRM can fix these in its environment settings.
              </p>
            </div>
          )}

          <section className="space-y-3" data-guide="mailboxes">
            <div className="flex items-center gap-2 px-1 pt-2">
              <h2 className="flex-1 font-medium">Mailboxes</h2>
              {note && <span className="text-c-fg2">{note}</span>}
              {mailboxes.some((m) => m.canRead) && (
                <Button onClick={readNow} disabled={reading}>
                  <RefreshCw className={cx('size-3.5 text-c-fg2', reading && 'animate-spin')} />
                  {reading ? 'Reading…' : 'Read now'}
                </Button>
              )}
            </div>
            {mailboxes.length === 0 && covered.length === 0 && (
              <p className="text-c-fg2 px-1">
                You didn't sign in with Google or Microsoft and haven't connected a mailbox, so
                emails you write here go out through the shared address and nothing is logged from
                your inbox.
              </p>
            )}
            <ul className="space-y-3">
              {mailboxes.map((m) => (
                <MailboxCard
                  key={`${m.provider}:${m.accountEmail}`}
                  mailbox={m}
                  canConnect={canConnect(m.provider)}
                />
              ))}
              {covered.map((c) => (
                <ConnectionCard
                  key={c.id}
                  connection={c}
                  reconnect={canConnect(c.provider)}
                  note="The CRM already reaches this mailbox through your sign-in, so this connection isn't used."
                />
              ))}
            </ul>
            <ConnectRow providers={mailboxProviders} ready={ready} verb="Connect" />
          </section>

          {otherProviders.length > 0 && (
            <section className="space-y-3">
              <h2 className="px-1 pt-2 font-medium">Other services</h2>
              <ul className="space-y-3">
                {others.map((c) => (
                  <ConnectionCard key={c.id} connection={c} reconnect={canConnect(c.provider)} />
                ))}
              </ul>
              <ConnectRow providers={otherProviders} ready={ready} verb="Connect" />
            </section>
          )}

          <p data-guide="mailbox-privacy" className="text-c-fg3 flex items-start gap-2 px-1 pt-2">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Only email and meetings with people who are already in the CRM are kept, as a subject
              line and a short preview; the rest of a mailbox is never stored. For the account you
              sign in with, the CRM stores no tokens. For an account you connect here, the tokens
              are encrypted before they are stored, and disconnecting deletes them.
            </span>
          </p>
        </div>
      </div>
    </>
  )
}
