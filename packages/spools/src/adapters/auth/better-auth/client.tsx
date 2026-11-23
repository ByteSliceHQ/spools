import { useRouteContext } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'
import {
  cloneElement,
  type FormEvent,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'

import { grants, isProvider, PROVIDERS, type ProviderId, providerIds } from '../../../crm/mailbox'
import type { AuthClient, Scopes } from '../../../crm/ui/auth'
import { Avatar, useDismiss } from '../../../crm/ui/kit'
import { API, LINK, LINK_MINUTES, REFUSED, SIGN_IN } from './shared'

/** The browser half of the Better Auth adapter (server.ts is the other). It talks to /api/auth and needs no SDK. */

// ── Talking to the server ───────────────────────────────────────────────────

type Answer = { ok: true; body: unknown } | { ok: false; error: string }

/** A value a request carries, as JSON. */
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

/** What a request to the server carries. A field that is undefined is left out, as JSON leaves it. */
type RequestBody = { readonly [field: string]: Json | undefined }

/** Text from the server, when there is some: anything else (missing, empty, not text) is none. */
const someText = z.string().min(1).optional().catch(undefined)

/** Why the server refused, in its own code. */
const Refusal = z.object({ code: someText })

/** Whether a way of signing in is set up: only a plain `true` says so. */
const offeredFlag = z.boolean().catch(false)

/** The ways of signing in the server has set up, besides links by email. */
const Methods = z.object({ google: offeredFlag, microsoft: offeredFlag } satisfies Record<
  ProviderId,
  typeof offeredFlag
>)

/** Where to go to finish at the provider. */
const Departure = z.object({ url: someText })

/** The person's accounts at providers, and what each has granted. One the server describes oddly is skipped. */
const LinkedAccounts = z
  .array(
    z
      .object({
        providerId: someText,
        scopes: z.array(z.string().nullable().catch(null)).catch([]),
      })
      .nullable()
      .catch(null),
  )
  .catch([])

/** Who the CRM pages say is signed in. */
const SignedIn = z.object({ user: z.object({ email: someText, name: someText }) })

async function call(path: string, body?: RequestBody): Promise<Answer> {
  try {
    const response = await fetch(`${API}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body && JSON.stringify(body),
    })

    const answer: unknown = await response.json().catch(() => null)

    if (response.ok) {
      return { ok: true, body: answer }
    }

    return {
      ok: false,
      error:
        response.status === 429 ? 'too_many' : (Refusal.safeParse(answer).data?.code ?? 'failed'),
    }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

/** The providers that are set up, besides links by email. */
async function providersOffered(): Promise<ProviderId[]> {
  const answer = await call('/methods')
  const methods = answer.ok ? Methods.safeParse(answer.body).data : undefined
  return methods ? providerIds.filter((id) => methods[id]) : []
}

/** Leaves for the provider's own page, or says why not. */
async function leaveFor(path: string, body: RequestBody): Promise<string | null> {
  const answer = await call(path, body)

  if (!answer.ok) {
    return answer.error
  }

  const url = Departure.safeParse(answer.body).data?.url

  if (!url) {
    return 'failed'
  }

  window.location.assign(url)
  return null
}

// ── What went wrong, in words ───────────────────────────────────────────────

const MESSAGES = {
  invalid_token: 'That link has expired or has already been used. Ask for a new one.',
  [REFUSED.notAllowed]:
    "That address isn't on the list of people who may use this CRM. Ask whoever runs it to add you.",
  [REFUSED.unverified]:
    "That address hasn't been confirmed as yours. Sign in with a link by email instead.",
  email_not_found:
    'That account has no address we can be sure is yours. Sign in with a link by email instead, or choose another account.',
  account_not_linked:
    "There is already an account with that address, and we couldn't confirm it is yours. Sign in with a link by email instead.",
  email_does_not_match:
    'That account has a different address from the one you sign in with. Choose the one that matches.',
  account_already_linked_to_different_user: 'That account belongs to someone else in this CRM.',
  unable_to_link_account:
    "That account couldn't be added, because its address hasn't been confirmed as yours.",
  access_denied: 'You left before finishing, so nothing was changed.',
  state_mismatch: 'That took too long, or was finished in another browser. Try again.',
  state_not_found: 'That took too long, or was finished in another browser. Try again.',
  please_restart_the_process: 'That took too long, or was finished in another browser. Try again.',
  invalid_origin:
    "This page was opened at an address the CRM doesn't know as its own. Open it at its usual address (APP_URL) to sign in.",
  oauth_provider_not_found: "That way of signing in isn't set up on this CRM.",
  provider_not_found: "That way of signing in isn't set up on this CRM.",
  validation_error: "That doesn't look like an email address.",
  too_many: 'Too many tries. Wait a minute, then try again.',
  offline: 'The CRM could not be reached. Check your connection and try again.',
}

/** Whether a code is one with its own words (an own key, so `constructor` and the like are not). */
const isExplained = (code: string): code is keyof typeof MESSAGES => Object.hasOwn(MESSAGES, code)

/** What a code from the server or the provider means to the person it stopped. */
export const explain = (code: string): string => {
  const known = code.toLowerCase()
  return isExplained(known) ? MESSAGES[known] : 'Something went wrong. Try again.'
}

// ── The sign-in page ────────────────────────────────────────────────────────

/** What the page's own address says: why a sign-in failed, or a link someone opened. */
type Arrival = { error: string | null; token: string | null; forAccount: boolean }

/**
 * Read once the page is in the browser. The server never sees what follows the
 * `#`, so the first thing drawn is the same on both sides: the plain form.
 */
function useArrival(): Arrival | null {
  const [arrival, setArrival] = useState<Arrival | null>(null)

  useEffect(() => {
    const read = () => {
      const query = new URLSearchParams(window.location.search)
      const fragment = new URLSearchParams(window.location.hash.slice(1))

      setArrival({
        error: query.get('error'),
        token: fragment.get(LINK),
        forAccount: query.get('for') === 'account',
      })
    }

    read()
    // A link opened in the tab that asked for it changes only what follows the "#".
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  return arrival
}

const wide =
  'flex h-9 w-full items-center justify-center rounded-lg text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50'

const primary = `${wide} bg-zinc-900 text-white hover:bg-zinc-700`
const secondary = `${wide} border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50`

/** `focus`: the keyboard was on something this takes the place of, so it goes to the heading. */
function Card({ title, focus, children }: { title: string; focus?: boolean; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (focus) {
      heading.current?.focus()
    }
  }, [focus])

  return (
    <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-700">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-base font-semibold text-zinc-900 outline-none"
      >
        {title}
      </h1>
      {children}
    </div>
  )
}

const Problem = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-red-800">
    {children}
  </p>
)

function SignIn({ path, redirectTo }: { path: string; redirectTo: string }) {
  const arrival = useArrival()
  const [another, setAnother] = useState(false)

  if (arrival?.forAccount && arrival.error) {
    return (
      <Card title="Your account wasn't changed">
        <Problem>{explain(arrival.error)}</Problem>
        <a href={redirectTo} className={`${secondary} mt-4`}>
          Back to the CRM
        </a>
      </Card>
    )
  }

  if (arrival?.token && !another) {
    return (
      <OpenedLink
        token={arrival.token}
        path={path}
        redirectTo={redirectTo}
        onAnother={() => setAnother(true)}
      />
    )
  }

  return (
    <AskForLink
      path={path}
      redirectTo={redirectTo}
      ready={arrival !== null}
      arrived={arrival?.error ?? null}
    />
  )
}

/**
 * Someone opened a link from an email. It is used up when they press the button
 * (not a link, which a filter might follow), not when their mail is checked.
 */
function OpenedLink({
  token,
  path,
  redirectTo,
  onAnother,
}: {
  token: string
  path: string
  redirectTo: string
  onAnother: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => button.current?.focus(), [])
  const query = new URLSearchParams({ token, callbackURL: redirectTo, errorCallbackURL: path })
  return (
    <Card title="Sign in">
      <p className="mt-2">You opened a sign-in link. It works once.</p>
      <button
        ref={button}
        type="button"
        onClick={() => window.location.assign(`${API}/magic-link/verify?${query}`)}
        className={`${primary} mt-4`}
      >
        Continue
      </button>
      <button
        type="button"
        onClick={onAnother}
        className="mt-3 text-zinc-500 underline hover:text-zinc-900"
      >
        Sign in another way
      </button>
    </Card>
  )
}

function AskForLink({
  path,
  redirectTo,
  ready,
  arrived,
}: {
  path: string
  redirectTo: string
  /** False until the page is running in the browser. Sent before that, the form would put the address in the page's. */
  ready: boolean
  /** Why a sign-in that ended here failed. */
  arrived: string | null
}) {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderId[]>([])
  const error = failed ?? arrived

  useEffect(() => {
    let here = true
    void providersOffered().then((offered) => here && setProviders(offered))

    return () => {
      here = false
    }
  }, [])

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = someText.parse(new FormData(event.currentTarget).get('email'))?.trim() ?? ''
    setBusy(true)
    const answer = await call('/sign-in/magic-link', { email, callbackURL: redirectTo })
    setBusy(false)
    setFailed(answer.ok ? null : answer.error)

    if (answer.ok) {
      setSentTo(email)
    }
  }

  const leave = async (provider: ProviderId) => {
    setBusy(true)

    const problem = await leaveFor('/sign-in/social', {
      provider,
      callbackURL: redirectTo,
      errorCallbackURL: path,
    })

    // Even when the browser is on its way: it may keep this page, and bring the person back to it.
    setBusy(false)
    setFailed(problem)
  }

  if (sentTo) {
    return (
      <Card title="Check your email" focus>
        <p className="mt-2">
          If <strong className="font-medium break-words text-zinc-900">{sentTo}</strong> may use
          this CRM, a link to sign in is on its way. It works once, in the next {LINK_MINUTES}{' '}
          minutes.
        </p>
        <button
          type="button"
          onClick={() => setSentTo(null)}
          className="mt-4 text-zinc-500 underline hover:text-zinc-900"
        >
          Use a different address
        </button>
      </Card>
    )
  }

  return (
    <Card title="Sign in">
      {error && <Problem>{explain(error)}</Problem>}
      <form onSubmit={ask} className="mt-4">
        <label htmlFor="sign-in-email" className="block font-medium text-zinc-900">
          Email address
        </label>
        <input
          id="sign-in-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1.5 block h-9 w-full rounded-lg border border-zinc-300 px-3 text-zinc-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
        <button type="submit" disabled={busy || !ready} className={`${primary} mt-3`}>
          Email me a link
        </button>
      </form>
      {providers.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-zinc-200 pt-4">
          {providers.map((id) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => leave(id)}
              className={secondary}
            >
              Continue with {PROVIDERS[id].label}
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── The account, once signed in ─────────────────────────────────────────────

async function signOut(): Promise<void> {
  const answer = await call('/sign-out', {})
  // A whole new page, so nothing the browser remembered about the person stays in it.
  window.location.assign(answer.ok ? SIGN_IN : `${SIGN_IN}?for=account&error=${answer.error}`)
}

function AccountButton() {
  // The CRM pages know who is signed in; anywhere else the button does without.
  const user = SignedIn.safeParse(useRouteContext({ strict: false })).data?.user
  const email = user?.email
  const name = user?.name ?? email ?? '?'
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useDismiss(menu, () => setOpen(false), open)

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="Your account"
        title="Your account"
        aria-haspopup="menu"
        aria-expanded={open}
        // The menu's own dismissal handles a press outside it, this button included.
        onPointerDown={(e) => open && e.stopPropagation()}
        onClick={() => setOpen(!open)}
        className="focus-visible:ring-c-accent shrink-0 rounded-full outline-none focus-visible:ring-2"
      >
        <Avatar name={name} round />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          tabIndex={-1}
          aria-label="Your account"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              button.current?.focus()
            }

            if (e.key === 'Tab') {
              setOpen(false)
            }
          }}
          className="border-c-line2 bg-c-raised absolute right-2 bottom-full left-2 z-40 mb-1 rounded-xl border p-1 shadow-xl shadow-black/10"
        >
          {email && (
            <div className="text-c-fg3 truncate px-2 pt-1.5 pb-1 text-[11px] font-medium">
              {email}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- The menu was opened on purpose; focus moves into it.
            autoFocus
            onClick={() => void signOut()}
            className="text-c-fg hover:bg-c-hov flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]"
          >
            <LogOut className="text-c-fg2 size-3.5" /> Sign out
          </button>
        </div>
      )}
    </>
  )
}

function SignOut({ children }: { children: ReactElement }) {
  return isValidElement<{ onClick?: () => void }>(children)
    ? cloneElement(children, { onClick: () => void signOut() })
    : children
}

/** Which of the person's accounts to ask for more: one that hasn't granted everything yet. */
async function accountToGrant(scopes: Scopes): Promise<ProviderId | null> {
  const [offered, answer] = await Promise.all([providersOffered(), call('/list-accounts')])
  const wanted = offered.filter((id) => scopes[id])
  const list = answer.ok ? LinkedAccounts.parse(answer.body) : []

  const linked = list.flatMap((account) => {
    const provider = account?.providerId
    return account && provider && isProvider(provider) && wanted.includes(provider)
      ? [{ provider, granted: account.scopes.filter((scope) => scope !== null) }]
      : []
  })

  const lacking = linked.find(({ provider, granted }) => !grants(granted, scopes[provider] ?? []))
  return (lacking ?? linked[0])?.provider ?? wanted[0] ?? null
}

async function openAccount(scopes: Scopes): Promise<void> {
  const provider = await accountToGrant(scopes)

  const problem = provider
    ? await leaveFor('/link-social', {
        provider,
        scopes: scopes[provider],
        callbackURL: `${window.location.pathname}${window.location.search}`,
        errorCallbackURL: `${SIGN_IN}?for=account`,
        // Google gives the means to read a mailbox later only when it asks the person afresh.
        ...(provider === 'google' && { additionalParams: { prompt: 'consent' } }),
      })
    : 'oauth_provider_not_found'

  if (problem !== null) {
    window.location.assign(`${SIGN_IN}?for=account&error=${encodeURIComponent(problem)}`)
  }
}

/** The browser half of sign-in with Better Auth. */
export const betterAuthClient: AuthClient = {
  id: 'better-auth',
  Provider: ({ children }) => <>{children}</>,
  SignIn,
  AccountButton,
  SignOut,
  useOpenAccount:
    () =>
    ({ scopes = {} } = {}) =>
      void openAccount(scopes),
}
