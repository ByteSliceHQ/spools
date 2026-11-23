import { useRouter, useRouterState } from '@tanstack/react-router'
import { Check, CircleQuestionMark, X } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'

import { markGuideFn, setGuideOffersFn } from '../../server/guides.functions'
import type { PublicCrmConfig } from '../config'
import {
  anchorOf,
  fill,
  type Guide,
  type GuideStep,
  guideToOffer,
  homeOf,
  inPlace,
  NO_OFFERS,
  OUTCOMES,
  type Outcome,
  type Place,
  parseWhere,
  placeOf,
  resolveGuides,
  shownSteps,
} from '../guides'
import { Button, cx, IconButton, useDismiss } from './kit'

/**
 * The guides' interface: the offer in the corner, the card that walks through a
 * guide's steps, and the Help menu that replays them. What a guide is, and
 * which one is offered when, is decided in `src/crm/guides.ts`.
 *
 * Nothing here is modal. The page stays usable under an offer and beside a
 * step, and neither appears while a dialog is open.
 */

/** What the session says about this person and guides. */
export type GuideProgress = { seen: string[]; offers: boolean }

type Mode =
  | { kind: 'idle' }
  | { kind: 'offer'; guide: Guide }
  | { kind: 'run'; guide: Guide; steps: GuideStep[]; index: number }
  /** Asked for from Help while somewhere else: starts once its place is on screen. */
  | { kind: 'pending'; guide: Guide; since: number; waitFor?: { record: string } }
  | { kind: 'nothing'; guide: Guide }

type GuideApi = {
  guides: Guide[]
  seen: ReadonlySet<string>
  /** False when this person asked not to be offered guides. */
  offering: boolean
  /** Start a guide on purpose, going to its page first when it belongs elsewhere. */
  start: (id: string) => void
  setOffering: (on: boolean) => void
}

const GuideContext = createContext<GuideApi | null>(null)

/** How long an offer waits for the page to settle, and how often a blocked one looks again. */
const SETTLE_MS = 1200
const RETRY_MS = 1500
/** How long a guide asked for from Help waits for its page to appear before saying there is nothing to show. */
const PENDING_MS = 4000

const PAGE_PATHS = {
  home: '/',
  tasks: '/tasks',
  notes: '/notes',
  files: '/files',
  reports: '/reports',
  workflows: '/workflows',
  integrations: '/integrations',
  assistant: '/assistant',
} as const

/** The element on the page that carries an anchor, if one is visible. */
function findAnchor(anchor: string): HTMLElement | null {
  const escaped = anchor.replace(/["\\]/g, '\\$&')

  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide~="${escaped}"]`)) {
    if (el.getClientRects().length > 0) {
      return el
    }
  }

  return null
}

const present = (anchor: string) => findAnchor(anchor) !== null

/**
 * Answers this browser has given that the server has not confirmed yet, per
 * person. An answer is written here first and removed once the server has it,
 * so one given just before the page is reloaded or closed, or while the
 * connection was down, still counts here and is sent again on the next visit.
 */
type Unsent = { marks: Record<string, Outcome>; offers?: boolean }
const unsentKey = (who: string) => `crm-guides-unsent:${who}`

/**
 * What storage holds, read back loosely: storage is anyone's to change, so
 * whatever does not fit is left out rather than failing the rest.
 */
const savedUnsent = z
  .object({
    marks: z.record(z.string(), z.unknown()).catch({}),
    offers: z.boolean().optional().catch(undefined),
  })
  .catch({ marks: {} })

const outcomeSchema = z.enum(OUTCOMES)

function readUnsent(who: string): Unsent {
  try {
    const saved = savedUnsent.parse(
      JSON.parse(window.localStorage.getItem(unsentKey(who)) ?? 'null'),
    )

    const marks = Object.entries(saved.marks).flatMap(([id, value]) => {
      const outcome = outcomeSchema.safeParse(value)
      return outcome.success ? [[id, outcome.data] as const] : []
    })

    return { marks: Object.fromEntries(marks), offers: saved.offers }
  } catch {
    // Storage is blocked or holds something else: the server is still told, just not twice.
    return { marks: {} }
  }
}

function changeUnsent(who: string, change: (unsent: Unsent) => Unsent): void {
  try {
    const next = change(readUnsent(who))

    if (Object.keys(next.marks).length === 0 && next.offers === undefined) {
      window.localStorage.removeItem(unsentKey(who))
    } else {
      window.localStorage.setItem(unsentKey(who), JSON.stringify(next))
    }
  } catch {
    // As above.
  }
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const dialogOpen = () => document.querySelector('dialog[open]') !== null

/**
 * Holds the guides for the session: which one is on offer or running, and what
 * this person has seen. Renders the offer and the step card after its children.
 */
export function GuideProvider({
  config,
  who,
  progress,
  searchOpen,
  openSearch,
  onStart,
  children,
}: {
  config: PublicCrmConfig
  /** Who is signed in (their email): answers waiting to be sent are kept per person. */
  who: string
  progress: GuideProgress
  /** Search (Cmd+K) is open over the page. */
  searchOpen: boolean
  openSearch: () => void
  /** A guide is about to start from the Help menu: get the sidebar out of the way on a phone. */
  onStart: () => void
  children: ReactNode
}) {
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const href = useRouterState({ select: (s) => s.location.href })
  const guides = useMemo(() => resolveGuides(config), [config])

  // What was answered in this tab, ahead of the session catching up with the server.
  const [marked, setMarked] = useState<string[]>([])
  const [offeringNow, setOfferingNow] = useState<boolean>()

  const seen = useMemo(() => {
    const all = new Set([...progress.seen, ...marked])

    if (offeringNow === true) {
      all.delete(NO_OFFERS)
    }

    if (offeringNow === false) {
      all.add(NO_OFFERS)
    }

    return all
  }, [progress.seen, marked, offeringNow])

  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  // Once an offer is answered or a guide ends, the page (or search) is left alone until the person moves on.
  const [quietPath, setQuietPath] = useState<string>()
  const [quietSearch, setQuietSearch] = useState(false)
  useEffect(() => setQuietPath((path) => (path === pathname ? path : undefined)), [pathname])

  useEffect(() => {
    if (!searchOpen) {
      setQuietSearch(false)
    }
  }, [searchOpen])

  const quiet = searchOpen ? quietSearch : quietPath === pathname

  const hush = useCallback(
    () => (searchOpen ? setQuietSearch(true) : setQuietPath(pathname)),
    [searchOpen, pathname],
  )

  const returnFocus = useRef<Element | null>(null)

  const placeNow = useCallback(
    (): Place => ({
      ...placeOf(pathname, config.objects),
      board: present('board'),
      search: searchOpen,
    }),
    [pathname, config.objects, searchOpen],
  )

  // Tell the server in the background. The answer stays in this browser until the
  // server's own list shows it (below), not merely until the request returns: a page
  // reloaded in that instant can be handed a list read just before the answer landed.
  const send = useCallback(
    (id: string, outcome: Outcome) => {
      changeUnsent(who, (u) => ({ ...u, marks: { ...u.marks, [id]: outcome } }))
      void markGuideFn({ data: { id, outcome } }).catch(() => undefined)
    },
    [who],
  )

  const sendOffering = useCallback(
    (on: boolean) => {
      changeUnsent(who, (u) => ({ ...u, offers: on }))
      void setGuideOffersFn({ data: { on } }).catch(() => undefined)
    },
    [who],
  )

  // Answers this browser holds that the server's list doesn't show yet count at
  // once. On arrival they are sent again, in case they never got there.
  const resent = useRef<string | undefined>(undefined)

  useEffect(() => {
    const onServer = new Set(progress.seen)
    const unsent = readUnsent(who)

    // A guide that has since been removed has nothing to record.
    const waiting = Object.entries(unsent.marks).filter(
      ([id]) => !onServer.has(id) && guides.some((g) => g.id === id),
    )

    const offers =
      unsent.offers !== undefined && unsent.offers === onServer.has(NO_OFFERS)
        ? unsent.offers
        : undefined

    changeUnsent(who, () => ({ marks: Object.fromEntries(waiting), offers }))

    if (waiting.length > 0) {
      setMarked((ids) => [...new Set([...ids, ...waiting.map(([id]) => id)])])
    }

    if (offers !== undefined) {
      setOfferingNow(offers)
    }

    if (resent.current === who) {
      return
    }

    resent.current = who

    for (const [id, outcome] of waiting) {
      send(id, outcome)
    }

    if (offers !== undefined) {
      sendOffering(offers)
    }
  }, [who, guides, progress.seen, send, sendOffering])

  const mark = useCallback(
    (id: string, outcome: Outcome) => {
      setMarked((ids) => (ids.includes(id) ? ids : [...ids, id]))
      send(id, outcome)
    },
    [send],
  )

  const run = useCallback((guide: Guide) => {
    const steps = shownSteps(guide, present)

    if (steps.length === 0) {
      return false
    }

    if (!returnFocus.current) {
      returnFocus.current = document.activeElement
    }

    setMode({ kind: 'run', guide, steps, index: 0 })
    return true
  }, [])

  const end = useCallback(
    (guide: Guide, outcome: Outcome) => {
      mark(guide.id, outcome)
      hush()
      setMode({ kind: 'idle' })
      const back = returnFocus.current
      returnFocus.current = null

      // Back to where the person was. The offer's own button is gone by now: search, if it is open, or the page is the next best place.
      if (back instanceof HTMLElement && back.isConnected) {
        back.focus()
      } else {
        const next =
          document.querySelector<HTMLElement>('[data-guide~="search-box"] input') ??
          document.querySelector<HTMLElement>('.crm main')

        next?.focus({ preventScroll: true })
      }
    },
    [mark, hush],
  )

  // Offer a guide once the page has settled, unless something is already showing.
  // `href` re-runs this when the view changes (a board appears).
  useEffect(() => {
    if (mode.kind !== 'idle' || quiet) {
      return undefined
    }

    let timer: ReturnType<typeof setTimeout>

    const look = () => {
      // A dialog has the person's attention: look again when it may have closed.
      if (dialogOpen()) {
        timer = setTimeout(look, RETRY_MS)
        return
      }

      const guide = guideToOffer(guides, placeNow(), seen, { offers: progress.offers, present })

      if (guide) {
        setMode({ kind: 'offer', guide })
      }
    }

    timer = setTimeout(look, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [mode.kind, quiet, href, guides, seen, progress.offers, placeNow])

  // Moving on takes an unanswered offer away (it comes back next time), and ends a guide that belonged to the page left behind.
  useEffect(() => {
    if (mode.kind === 'offer' && !inPlace(mode.guide.where, placeNow())) {
      setMode({ kind: 'idle' })
    }

    if (mode.kind === 'run') {
      const place = placeNow()
      const forSearch = mode.guide.where === 'search'

      // Opening search over another guide only hides it for a moment (the card is not rendered then).
      if (!inPlace(mode.guide.where, forSearch ? place : { ...place, search: false })) {
        end(mode.guide, 'dismissed')
      }
    }
  }, [mode, placeNow, end])

  // A guide asked for from Help starts when its page is on screen.
  // `href` re-runs this as the page changes.
  useEffect(() => {
    if (mode.kind !== 'pending') {
      return undefined
    }

    const { guide, waitFor, since } = mode
    let timer: ReturnType<typeof setTimeout>

    const look = () => {
      if (inPlace(guide.where, placeNow()) && !dialogOpen() && run(guide)) {
        return
      }

      // Waiting for the person to open a record has no time limit: the card says what to do.
      if (!waitFor && Date.now() - since > PENDING_MS) {
        setMode({ kind: 'nothing', guide })
      } else {
        timer = setTimeout(look, 300)
      }
    }

    timer = setTimeout(look, 150)
    return () => clearTimeout(timer)
  }, [mode, href, placeNow, run])

  const start = useCallback(
    (id: string) => {
      const guide = guides.find((g) => g.id === id)

      if (!guide) {
        return
      }

      onStart()
      returnFocus.current = document.activeElement
      const home = homeOf(guide, config)
      const place = placeNow()

      if (inPlace(guide.where, place)) {
        setMode({ kind: 'pending', guide, since: Date.now() })
        return
      }

      // A guide about records can't open one for you. Any list will do when it is for every object.
      const anyObject = parseWhere(guide.where)?.object === undefined

      const onAList =
        home.needs === 'record' &&
        place.page === 'list' &&
        (anyObject || place.object === home.object)

      const object = onAList ? place.object : home.object

      if (home.needs === 'search') {
        openSearch()
      } else if (home.page) {
        void router.navigate({ to: PAGE_PATHS[home.page] })
      } else if (object && !onAList) {
        void router.navigate({
          to: '/$object',
          params: { object },
          search: home.view ? { view: home.view } : {},
        })
      }

      const record = (object && config.objects[object]?.label.toLowerCase()) || 'record'

      setMode({
        kind: 'pending',
        guide,
        since: Date.now(),
        waitFor: home.needs === 'record' ? { record } : undefined,
      })
    },
    [guides, config, placeNow, openSearch, onStart, router],
  )

  const setOffering = useCallback(
    (on: boolean) => {
      setOfferingNow(on)
      sendOffering(on)
    },
    [sendOffering],
  )

  const api = useMemo<GuideApi>(
    () => ({ guides, seen, offering: !seen.has(NO_OFFERS), start, setOffering }),
    [guides, seen, start, setOffering],
  )

  const place = { ...placeOf(pathname, config.objects), search: searchOpen }
  const words = (text: string) => fill(text, config, place)
  const runStep = mode.kind === 'run' ? mode.steps[mode.index] : undefined

  return (
    <GuideContext value={api}>
      {children}
      {mode.kind === 'offer' && (
        <Offer
          title={words(mode.guide.title)}
          steps={shownSteps(mode.guide, present).length}
          onAccept={() => {
            if (!run(mode.guide)) {
              setMode({ kind: 'idle' })
            }
          }}
          onDecline={() => end(mode.guide, 'dismissed')}
          onNever={() => {
            setOffering(false)
            hush()
            setMode({ kind: 'idle' })
          }}
        />
      )}
      {mode.kind === 'run' && runStep && !(searchOpen && mode.guide.where !== 'search') && (
        <StepCard
          guide={words(mode.guide.title)}
          step={runStep}
          words={words}
          index={mode.index}
          count={mode.steps.length}
          onBack={() => setMode({ ...mode, index: Math.max(0, mode.index - 1) })}
          onNext={() =>
            mode.index >= mode.steps.length - 1
              ? end(mode.guide, 'finished')
              : setMode({ ...mode, index: mode.index + 1 })
          }
          onClose={() => end(mode.guide, 'dismissed')}
        />
      )}
      {(mode.kind === 'pending' && mode.waitFor) || mode.kind === 'nothing' ? (
        <Notice
          text={
            mode.kind === 'nothing'
              ? `“${words(mode.guide.title)}” has nothing to show on this page.`
              : `Open any ${mode.waitFor?.record} and “${words(mode.guide.title)}” will start.`
          }
          action={mode.kind === 'nothing' ? 'OK' : 'Cancel'}
          onClose={() => {
            returnFocus.current = null
            setMode({ kind: 'idle' })
          }}
        />
      ) : null}
    </GuideContext>
  )
}

const corner =
  'fixed right-2 bottom-2 left-2 z-[60] rounded-xl border border-c-line2 bg-c-raised p-3 text-c-fg shadow-xl shadow-black/15 sm:right-4 sm:bottom-14 sm:left-auto sm:w-80'

/** The question in the corner: take the guide, or never be asked about it again. It never takes focus. */
function Offer({
  title,
  steps,
  onAccept,
  onDecline,
  onNever,
}: {
  title: string
  steps: number
  onAccept: () => void
  onDecline: () => void
  onNever: () => void
}) {
  const heading = useId()
  return (
    <section aria-labelledby={heading} className={corner}>
      {/* Read out when it appears; the card itself is reached with Tab. */}
      <p role="status" className="sr-only">
        A guide is available: {title}. {steps} {steps === 1 ? 'step' : 'steps'}.
      </p>
      <p className="text-c-fg3 text-[11px] font-medium">
        Guide · {steps} short {steps === 1 ? 'step' : 'steps'}
      </p>
      <h2 id={heading} className="mt-0.5 font-semibold">
        {title}
      </h2>
      <p className="text-c-fg2 mt-1">
        Want to see how this works? You can replay it later from Help.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button variant="primary" onClick={onAccept}>
          Show me
        </Button>
        <Button onClick={onDecline}>No thanks</Button>
        <button
          type="button"
          onClick={onNever}
          className="text-c-fg3 hover:text-c-fg ml-auto rounded px-1 text-xs underline-offset-2 hover:underline"
        >
          Don't offer guides
        </button>
      </div>
    </section>
  )
}

/** A line in the corner with one way out: what a guide asked for from Help is waiting for. */
function Notice({ text, action, onClose }: { text: string; action: string; onClose: () => void }) {
  return (
    <div role="status" className={cx(corner, 'flex items-center gap-3')}>
      <p className="min-w-0 flex-1">{text}</p>
      <Button onClick={onClose}>{action}</Button>
    </div>
  )
}

/** Where something is on screen. `column` is the right edge of the side column it sits in, if it is in one. */
type Box = { top: number; left: number; width: number; height: number; column: number | null }
const GAP = 10
const EDGE = 8

/** A position along one side of the screen, pulled in so a box of `size` stays clear of the edges. */
const within = (value: number, size: number, limit: number) =>
  Math.max(EDGE, Math.min(value, limit - size - EDGE))

/**
 * Where the card goes: next to what it points at when there is room, otherwise
 * in the corner. Under or over the target by default; for something in a side
 * column (the sidebar, a record's details) beside it, so the column stays readable.
 */
function placeCard(target: Box | null, card: { width: number; height: number }, narrow: boolean) {
  const vw = window.innerWidth
  const vh = window.innerHeight

  // A phone has no room beside anything: a sheet along the edge the target is not near.
  if (narrow) {
    const low = target ? target.top + target.height / 2 > vh / 2 : false
    return low ? { top: EDGE, left: EDGE, right: EDGE } : { bottom: EDGE, left: EDGE, right: EDGE }
  }

  if (target) {
    const left = within(target.left, card.width, vw)
    const top = within(target.top, card.height, vh)

    const under = {
      fits: target.top + target.height + GAP + card.height + EDGE <= vh,
      at: { top: target.top + target.height + GAP, left },
    }

    const over = {
      fits: target.top - GAP - card.height >= EDGE,
      at: { top: target.top - GAP - card.height, left },
    }

    // Past the edge of the column, not just past the target, so the rest of the column can still be read.
    const edge = Math.max(target.left + target.width, target.column ?? 0)
    const after = { fits: edge + GAP + card.width + EDGE <= vw, at: { top, left: edge + GAP } }

    const before = {
      fits: target.left - GAP - card.width >= EDGE,
      at: { top, left: target.left - GAP - card.width },
    }

    const order =
      target.column !== null ? [after, before, under, over] : [under, over, after, before]

    const side = order.find((s) => s.fits)

    if (side) {
      return side.at
    }
  }

  return { right: 16, bottom: 16 }
}

/** One step of a running guide, pointing at its anchor when that is on the page. */
function StepCard({
  guide,
  step,
  words,
  index,
  count,
  onBack,
  onNext,
  onClose,
}: {
  guide: string
  step: GuideStep
  words: (text: string) => string
  index: number
  count: number
  onBack: () => void
  onNext: () => void
  onClose: () => void
}) {
  const heading = useId()
  const body = useId()
  const card = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const [target, setTarget] = useState<Box | null>(null)
  const [size, setSize] = useState({ width: 340, height: 160 })
  const [narrow, setNarrow] = useState(false)
  const last = index === count - 1

  // Bring what the step points at into view, once, when the step appears.
  useEffect(() => {
    const anchor = anchorOf(step, present)
    const el = anchor ? findAnchor(anchor) : null

    el?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: reducedMotion() ? 'auto' : 'smooth',
    })
  }, [step])

  // Follow the anchor as the page scrolls, resizes or changes under it.
  useLayoutEffect(() => {
    const measure = () => {
      setNarrow(window.matchMedia('(max-width: 639px)').matches)
      const anchor = anchorOf(step, present)
      const el = anchor ? findAnchor(anchor) : null
      const rect = el?.getBoundingClientRect()

      const box = rect
        ? {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            column: el?.closest('aside')?.getBoundingClientRect().right ?? null,
          }
        : null

      setTarget((was) => (JSON.stringify(was) === JSON.stringify(box) ? was : box))
      const own = card.current

      if (own) {
        setSize((was) =>
          was.width === own.offsetWidth && was.height === own.offsetHeight
            ? was
            : { width: own.offsetWidth, height: own.offsetHeight },
        )
      }
    }

    measure()
    const timer = setInterval(measure, 250)
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, true)

    return () => {
      clearInterval(timer)
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, true)
    }
  }, [step])

  // Starting a guide is something the person asked for, so focus goes to it; later steps keep it there.
  useEffect(() => {
    next.current?.focus({ preventScroll: true })
  }, [])

  return (
    <>
      {target && (
        <div
          aria-hidden="true"
          className="border-c-accent pointer-events-none fixed z-[55] rounded-lg border-2 shadow-[0_0_0_4px_color-mix(in_srgb,var(--c-accent)_22%,transparent)]"
          style={{
            top: target.top - 4,
            left: target.left - 4,
            width: target.width + 8,
            height: target.height + 8,
          }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby={heading}
        aria-describedby={body}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Only the guide closes: a menu or search open underneath is left alone.
            e.stopPropagation()
            onClose()
          } else if (e.key === 'ArrowRight') {
            onNext()
          } else if (e.key === 'ArrowLeft' && index > 0) {
            onBack()
          }
        }}
        className="border-c-line2 bg-c-raised text-c-fg fixed z-[60] rounded-xl border p-3 shadow-xl shadow-black/15 sm:w-[340px]"
        style={placeCard(target, size, narrow)}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
            <p className="text-c-fg3 text-[11px] font-medium">
              {guide} · Step {index + 1} of {count}
            </p>
            <h2 id={heading} className="mt-0.5 font-semibold">
              {words(step.title)}
            </h2>
            <p id={body} className="text-c-fg2 mt-1">
              {words(step.body)}
            </p>
          </div>
          <IconButton label="Close guide" className="-mt-1 -mr-1 size-6" onClick={onClose}>
            <X className="size-3.5" />
          </IconButton>
        </div>
        <div className="mt-3 flex items-center gap-1.5">
          <span aria-hidden="true" className="flex gap-1">
            {Array.from({ length: count }, (_, i) => (
              <span
                // The dots are only positions.
                key={i}
                className={cx('size-1.5 rounded-full', i === index ? 'bg-c-accent' : 'bg-c-line2')}
              />
            ))}
          </span>
          <div className="ml-auto flex gap-1.5">
            {index > 0 && <Button onClick={onBack}>Back</Button>}
            <Button ref={next} variant="primary" onClick={onNext}>
              {last ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * The Help button and its menu: every guide, which ones this person has not
 * seen, and the switch for offers. Its parent must be `relative`; the menu
 * opens above it and spans it.
 */
export function GuideHelp() {
  const api = useContext(GuideContext)
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    button.current?.focus()
  }, [])

  useDismiss(menu, () => setOpen(false), open)

  if (!api) {
    return null
  }

  return (
    <>
      <IconButton
        ref={button}
        label="Help and guides"
        className="size-6"
        data-guide="help"
        aria-haspopup="menu"
        aria-expanded={open}
        // The menu's own dismissal handles a press outside it, this button included.
        onPointerDown={(e) => open && e.stopPropagation()}
        onClick={() => setOpen(!open)}
      >
        <CircleQuestionMark className="size-3.5" />
      </IconButton>
      {open && (
        <div
          ref={menu}
          role="menu"
          tabIndex={-1}
          aria-label="Guides"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
              return
            }

            e.preventDefault()

            const items = [
              ...(menu.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? []),
            ]

            const active = document.activeElement
            const at = active instanceof HTMLElement ? items.indexOf(active) : -1
            items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
          }}
          className="border-c-line2 bg-c-raised absolute right-2 bottom-full left-2 z-40 mb-1 max-h-[70vh] overflow-y-auto rounded-xl border p-1 shadow-xl shadow-black/10"
        >
          <div className="text-c-fg3 px-2 pt-1.5 pb-1 text-[11px] font-medium">Guides</div>
          {api.guides.map((guide, i) => {
            const done = api.seen.has(guide.id)
            return (
              <button
                key={guide.id}
                type="button"
                role="menuitem"
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- The menu was opened on purpose; focus moves into it.
                autoFocus={i === 0}
                onClick={() => {
                  setOpen(false)
                  api.start(guide.id)
                }}
                className="text-c-fg hover:bg-c-hov flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]"
              >
                <span className="min-w-0 flex-1">{guide.title}</span>
                {done ? (
                  <Check className="text-c-fg3 size-3.5 shrink-0" aria-label="Seen" />
                ) : (
                  <span className="bg-c-sel text-c-accent shrink-0 rounded px-1 text-[10px] font-semibold">
                    New
                  </span>
                )}
              </button>
            )
          })}
          <div className="border-c-line -mx-1 my-1 border-t" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={api.offering}
            onClick={() => api.setOffering(!api.offering)}
            className="text-c-fg hover:bg-c-hov flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]"
          >
            <span className="min-w-0 flex-1">Offer guides as I go</span>
            {api.offering && <Check className="text-c-accent size-3.5 shrink-0" />}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={close}
            className="sr-only focus:not-sr-only focus:block focus:w-full focus:rounded-lg focus:px-2 focus:py-1.5 focus:text-left"
          >
            Close
          </button>
        </div>
      )}
    </>
  )
}
