import { Link, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  RotateCw,
  Search,
  Square,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import {
  Children,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { z } from 'zod'

import {
  type ChatSession,
  groupByRecency,
  isToolPart,
  type MessagePart,
  matchChats,
  type RecordRef,
  recordsFrom,
  stepsSummary,
  type ToolStep,
  textOf,
  toolStep,
} from '../assistant'
import type { PublicCrmConfig } from '../config'
import { ObjectIcon } from './icons'
import { Button, cx, Dialog, useDismiss } from './kit'
import { objectIndex } from './shell'

/**
 * The parts of the Ask page (`src/routes/_crm/assistant.tsx`): the chat list in
 * the sidebar, the composer, and how a conversation's messages are drawn. It is
 * laid out the way people know chat assistants to be, in the CRM's own colours.
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-c-accent/60'

/** Whether this is a touch screen, where Enter makes a new line and nothing takes focus unasked. */
const isTouch = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

function ActionButton({
  label,
  onClick,
  children,
  text,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  /** Show the label beside the icon. */
  text?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={text ? undefined : label}
      title={text ? undefined : label}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg text-c-fg2 transition-colors hover:bg-c-hov hover:text-c-fg motion-reduce:transition-none [&_svg]:size-4',
        text ? 'px-2 text-xs' : 'w-8',
        focusRing,
      )}
    >
      {children}
      {text && <span>{label}</span>}
    </button>
  )
}

const readerSchema = z.function({ input: [], output: z.string() })
const plainTextSchema = z.string().catch('')

/** The text to copy: as given, or read now from the function given in its place. */
function copyText(text: string | (() => string)): string {
  const reader = readerSchema.safeParse(text)
  return reader.success ? reader.data() : plainTextSchema.parse(text)
}

/** Copies text and says so for a moment. `text` may be read at the moment of the click. */
export function CopyButton({
  text,
  label = 'Copy',
  showText,
}: {
  text: string | (() => string)
  label?: string
  showText?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') {
      return undefined
    }

    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <ActionButton
      text={showText}
      label={state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}
      onClick={() => {
        navigator.clipboard
          .writeText(copyText(text))
          .then(() => setState('copied'))
          .catch(() => setState('failed'))
      }}
    >
      {state === 'copied' ? <Check /> : <Copy />}
    </ActionButton>
  )
}

/** The dot shown before a reply's first word. */
export function ThinkingDot({ name }: { name: string }) {
  return (
    <div className="flex h-7 items-center">
      <span
        aria-hidden="true"
        className="crm-chat-dot bg-c-fg inline-block size-3.5 rounded-full"
      />
      <span className="sr-only">{name} is thinking</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The sidebar: new chat, search, and past chats by recency
// ---------------------------------------------------------------------------

const sideItem = cx(
  'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-c-fg hover:bg-c-hov',
  focusRing,
)

export function ChatSidebar({
  configured,
  chats,
  current,
  onNew,
  onDelete,
}: {
  configured: boolean
  chats: ChatSession[]
  current?: string
  onNew: () => void
  onDelete: (chat: ChatSession) => void
}) {
  const [searching, setSearching] = useState(false)
  const [typed, setTyped] = useState('')
  const [shortcut, setShortcut] = useState('')

  useEffect(() => {
    setShortcut(/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⇧⌘O' : 'Ctrl+Shift+O')
  }, [])

  const titled = useMemo(() => chats.map((c) => ({ ...c, title: c.title || 'New chat' })), [chats])

  const groups = useMemo(
    () => groupByRecency(matchChats(titled, typed), new Date()),
    [titled, typed],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-px px-2 pb-2">
        <Link to="/" className={cx(sideItem, 'text-c-fg2')}>
          <ArrowLeft className="size-4 shrink-0" /> Back to the CRM
        </Link>
        {configured && (
          <>
            <button type="button" data-guide="assistant-new" onClick={onNew} className={sideItem}>
              <SquarePen className="size-4 shrink-0" /> New chat
              <span className="text-c-fg3 ml-auto hidden text-[11px] md:inline" aria-hidden="true">
                {shortcut}
              </span>
            </button>
            {searching ? (
              <div className="relative">
                <Search className="text-c-fg3 pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <label htmlFor="chat-search" className="sr-only">
                  Search chats
                </label>
                <input
                  id="chat-search"
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- Opened by asking to search.
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setTyped('')
                      setSearching(false)
                    }
                  }}
                  placeholder="Search chats"
                  className="border-c-line2 bg-c-raised placeholder:text-c-fg3 focus:border-c-accent focus:ring-c-accent/20 h-9 w-full rounded-lg border pr-8 pl-8.5 text-[14px] focus:ring-2 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label="Close search"
                  onClick={() => {
                    setTyped('')
                    setSearching(false)
                  }}
                  className={cx(
                    'absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-c-fg3 hover:text-c-fg',
                    focusRing,
                  )}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setSearching(true)} className={sideItem}>
                <Search className="size-4 shrink-0" /> Search chats
              </button>
            )}
          </>
        )}
      </div>
      {configured && (
        <nav
          aria-label="Chats"
          data-guide="assistant-chats"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        >
          {groups.length === 0 && (
            <p className="text-c-fg3 px-2.5 py-4 text-[13px]">
              {typed ? 'No chats match.' : 'Your chats will show here.'}
            </p>
          )}
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="text-c-fg3 px-2.5 pt-5 pb-1.5 text-xs font-medium">{group.label}</h3>
              <ul className="space-y-px">
                {group.chats.map((chat) => (
                  <ChatItem
                    key={chat.sessionId}
                    chat={chat}
                    current={chat.sessionId === current}
                    onDelete={() =>
                      onDelete(chats.find((c) => c.sessionId === chat.sessionId) ?? chat)
                    }
                  />
                ))}
              </ul>
            </section>
          ))}
        </nav>
      )}
    </div>
  )
}

function ChatItem({
  chat,
  current,
  onDelete,
}: {
  chat: ChatSession & { title: string }
  current: boolean
  onDelete: () => void
}) {
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <li className="group relative">
      <Link
        to="."
        search={{ session: chat.sessionId }}
        aria-current={current ? 'page' : undefined}
        title={chat.title}
        className={cx(
          'flex h-9 items-center rounded-lg pr-9 pl-2.5 text-[14px] hover:bg-c-hov',
          current && 'bg-c-hov',
          focusRing,
        )}
      >
        <span className="truncate">{chat.title}</span>
      </Link>
      <button
        ref={button}
        type="button"
        aria-label={`Options for ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={() => {
          const at = button.current?.getBoundingClientRect()
          setMenu(menu || !at ? null : { top: at.bottom + 4, left: Math.max(8, at.right - 176) })
        }}
        className={cx(
          'absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-c-fg2 hover:bg-c-line2/60 hover:text-c-fg',
          current || menu
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          focusRing,
        )}
      >
        <Ellipsis className="size-4" />
      </button>
      {menu && (
        <ChatMenu
          at={menu}
          onClose={(refocus) => {
            setMenu(null)

            if (refocus) {
              button.current?.focus()
            }
          }}
          onDelete={onDelete}
        />
      )}
    </li>
  )
}

/** A chat's menu. Fixed to the window so the list's scrolling can't clip it. */
function ChatMenu({
  at,
  onClose,
  onDelete,
}: {
  at: { top: number; left: number }
  onClose: (refocus: boolean) => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useDismiss(ref, () => onClose(true))

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    // The list scrolling away from the button would leave the menu floating on its own.
    const away = () => close.current(false)
    window.addEventListener('resize', away)
    document.addEventListener('scroll', away, true)

    return () => {
      window.removeEventListener('resize', away)
      document.removeEventListener('scroll', away, true)
    }
  }, [])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ top: at.top, left: at.left }}
      className="border-c-line2 bg-c-raised fixed z-50 w-44 rounded-xl border p-1 shadow-xl shadow-black/10"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose(false)
          onDelete()
        }}
        className={cx(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[14px] text-c-danger hover:bg-c-hov',
          focusRing,
        )}
      >
        <Trash2 className="size-4" /> Delete
      </button>
    </div>
  )
}

export function DeleteChatDialog({
  chat,
  onCancel,
  onConfirm,
}: {
  chat: ChatSession | null
  onCancel: () => void
  onConfirm: (chat: ChatSession) => void
}) {
  return (
    <Dialog open={!!chat} onClose={onCancel} title="Delete chat?" width="max-w-md">
      <p className="text-[14px] leading-6">
        This deletes <strong className="font-semibold">{chat?.title || 'this chat'}</strong> and
        everything said in it. Records the assistant changed stay as they are.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          className="bg-c-danger hover:bg-c-danger/90 text-white"
          variant="primary"
          onClick={() => chat && onConfirm(chat)}
        >
          Delete
        </Button>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

const COMPOSER_MAX = 208

export function Composer({
  value,
  onChange,
  onSend,
  busy,
  onStop,
  inputRef,
  name,
  focusOnMount,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** A reply is on its way: the send button becomes Stop. */
  busy: boolean
  /** Without it, Stop is shown but can't be pressed yet. */
  onStop?: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  name: string
  focusOnMount?: boolean
}) {
  // Grow with what is typed, up to a limit, then scroll. Measured again when the text or the box's width changes.
  useLayoutEffect(() => {
    const box = inputRef.current

    if (!box) {
      return undefined
    }

    const fit = () => {
      box.style.height = 'auto'

      if (!box.value) {
        return
      } // One row, whatever the placeholder would wrap to.

      box.style.height = `${Math.min(box.scrollHeight, COMPOSER_MAX)}px`
      box.style.overflowY = box.scrollHeight > COMPOSER_MAX ? 'auto' : 'hidden'
    }

    fit()
    let width = box.clientWidth

    const watch = new ResizeObserver(() => {
      if (box.clientWidth === width) {
        return
      }

      width = box.clientWidth
      fit()
    })

    watch.observe(box)
    return () => watch.disconnect()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Measure again whenever the text changes.
  }, [value])

  useEffect(() => {
    if (focusOnMount && !isTouch()) {
      inputRef.current?.focus()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Once, when the composer appears.
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends and Shift+Enter makes a new line. On a phone Enter is a new line, as its keyboard says.
    // Leave Enter alone while an input method is composing a character.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch()) {
      e.preventDefault()

      if (!busy) {
        onSend()
      }
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()

        if (!busy) {
          onSend()
        }
      }}
    >
      <div
        data-guide="assistant-box"
        className="border-c-line2 bg-c-raised focus-within:border-c-fg3 focus-within:ring-c-accent/20 flex items-end gap-2 rounded-[28px] border py-2 pr-2 pl-5 shadow-[0_2px_12px_rgb(0_0_0/0.06)] focus-within:ring-2 dark:shadow-none"
      >
        <label htmlFor="chat-input" className="sr-only">
          Message {name}
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={`Ask ${name}`}
          className="placeholder:text-c-fg3 min-h-9 min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-1.5 text-[15px] leading-6 outline-none"
        />
        {busy ? (
          <button
            type="button"
            aria-label="Stop the reply"
            title="Stop"
            disabled={!onStop}
            onClick={onStop}
            className={cx(
              'flex size-9 shrink-0 items-center justify-center rounded-full bg-c-fg text-c-bg disabled:opacity-40',
              focusRing,
            )}
          >
            <Square className="size-3.5" fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            title="Send"
            disabled={!value.trim()}
            className={cx(
              'flex size-9 shrink-0 items-center justify-center rounded-full bg-c-fg text-c-bg transition-opacity disabled:opacity-25 motion-reduce:transition-none',
              focusRing,
            )}
          >
            <ArrowUp className="size-[18px]" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A text part of a message. Parts arrive loosely typed, so each is checked before its text is read. */
const textPartSchema = z.object({ type: z.literal('text'), text: z.string() })

/** The text a part carries: one string for a text part, none for anything else. */
function textOfPart(part: MessagePart): string[] {
  const textPart = textPartSchema.safeParse(part)
  return textPart.success ? [textPart.data.text] : []
}

export function UserMessage({ parts }: { parts: MessagePart[] }) {
  const text = parts.flatMap(textOfPart).join('\n').trim()

  return (
    <div className="group/user relative flex flex-col items-end">
      <h2 className="sr-only">You said:</h2>
      <div className="bg-c-hov dark:bg-c-line2 max-w-[85%] rounded-3xl px-5 py-2.5 text-[15px] leading-7 break-words whitespace-pre-wrap sm:max-w-[70%]">
        {text}
      </div>
      {/* Under the bubble, in the space between turns, so it doesn't push the reply down. */}
      <div className="absolute top-full right-0 mt-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
        <CopyButton text={text} label="Copy message" />
      </div>
    </div>
  )
}

/** A code block with its language and a copy button above it. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null)
  const code = Children.toArray(children)[0]
  const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : ''
  const language = /language-([\w+#-]+)/.exec(className)?.[1]
  return (
    <div className="border-c-line bg-c-panel my-4 overflow-hidden rounded-2xl border">
      <div className="border-c-line text-c-fg2 flex h-9 items-center justify-between border-b pr-1 pl-4 text-xs">
        <span>{language ?? 'code'}</span>
        <CopyButton text={() => pre.current?.textContent ?? ''} label="Copy code" showText />
      </div>
      <pre ref={pre} className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6">
        {children}
      </pre>
    </div>
  )
}

const prose = cx(
  'min-w-0 text-[15px] leading-7 break-words text-c-fg',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-3',
  '[&_h1]:mt-7 [&_h1]:mb-3 [&_h1]:text-[22px] [&_h1]:leading-8 [&_h1]:font-semibold',
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-[19px] [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li]:pl-1 [&_li>ol]:my-1 [&_li>ul]:my-1',
  '[&_strong]:font-semibold [&_hr]:my-6 [&_hr]:border-c-line',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-c-line2 [&_blockquote]:pl-4 [&_blockquote]:text-c-fg2',
  '[&_th]:border-b [&_th]:border-c-line2 [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold',
  '[&_td]:border-b [&_td]:border-c-line [&_td]:px-3 [&_td]:py-2 [&_tr:last-child>td]:border-b-0',
  '[&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-c-hov [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.86em]',
)

const linkClass =
  'font-medium text-c-accent underline decoration-c-accent/40 underline-offset-2 hover:decoration-c-accent'

/**
 * How a reply's Markdown is drawn. `navigate` opens a link into the CRM. Exported for tests.
 *
 * The assistant writes Markdown. Raw HTML is not rendered, and link addresses are checked by
 * react-markdown. An image becomes a link: a browser fetches an image without being asked,
 * so text the model read (a note, an email preview) could otherwise have it send what it knows
 * to another server in the address.
 */
export function replyComponents(navigate: (href: string) => void): Components {
  return {
    a: ({ href, children }) => {
      // A link into the CRM stays in this tab; anything else opens in a new one.
      if (href?.startsWith('/') && !href.startsWith('//')) {
        return (
          <a
            href={href}
            className={linkClass}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                return
              }

              e.preventDefault()
              navigate(href)
            }}
          >
            {children}
          </a>
        )
      }

      return (
        <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
          {children}
        </a>
      )
    },
    img: ({ src, alt }) =>
      src ? (
        <a href={src} target="_blank" rel="noreferrer" className={linkClass}>
          {alt || 'image'}
        </a>
      ) : (
        <>{alt}</>
      ),
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => (
      <div className="border-c-line my-4 overflow-x-auto rounded-xl border">
        <table className="w-full border-collapse text-left text-[14px]">{children}</table>
      </div>
    ),
  }
}

function Reply({ text }: { text: string }) {
  const router = useRouter()

  const components = useMemo(
    () => replyComponents((href) => void router.navigate({ href })),
    [router],
  )

  return (
    <div className={prose}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}

const stepIcon: Record<ToolStep['status'], ReactNode> = {
  running: <span className="crm-chat-dot bg-c-fg3 mt-2 block size-2 rounded-full" />,
  done: <Check className="text-c-fg3 mt-1 size-3.5" strokeWidth={2.5} />,
  failed: <X className="text-c-danger mt-1 size-3.5" strokeWidth={2.5} />,
  stopped: <Square className="text-c-fg3 mt-1.5 size-2.5" fill="currentColor" strokeWidth={0} />,
}

/** What the assistant looked up or changed: one quiet line that opens into the steps. */
function ToolSteps({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false)
  const running = steps.some((s) => s.status === 'running')
  const failed = !running && steps.some((s) => s.status === 'failed')
  return (
    <div className="my-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          'inline-flex max-w-full items-center gap-1 rounded-md text-[14px] leading-7 text-c-fg3 hover:text-c-fg2',
          focusRing,
        )}
      >
        <span className={cx('truncate', running && 'crm-chat-working', failed && 'text-c-danger')}>
          {stepsSummary(steps)}
        </span>
        <ChevronRight
          className={cx(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <ol className="border-c-line text-c-fg2 mt-1 mb-3 ml-1.5 space-y-1.5 border-l pl-4 text-[14px] leading-6">
          {steps.map((s, i) => (
            // A reply's steps only ever append.
            <li key={i} className="flex gap-2.5">
              <span className="flex w-3.5 shrink-0 justify-center" aria-hidden="true">
                {stepIcon[s.status]}
              </span>
              <span className="min-w-0">
                <span className={cx(s.status === 'failed' && 'text-c-danger')}>
                  {s.label}
                  {s.status === 'stopped' && ' (stopped)'}
                </span>
                {s.detail && <span className="text-c-fg3 block text-[13px]">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function SourcesButton({
  records,
  config,
  open,
  onToggle,
}: {
  records: RecordRef[]
  config: PublicCrmConfig
  open: boolean
  onToggle: () => void
}) {
  const kinds = [...new Set(records.map((r) => r.objectKey))].slice(0, 3)
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cx(
        'ml-1 inline-flex h-8 items-center gap-2 rounded-full border border-c-line px-2.5 text-[13px] text-c-fg2 hover:bg-c-hov hover:text-c-fg',
        open && 'bg-c-hov text-c-fg',
        focusRing,
      )}
    >
      <span className="flex -space-x-1" aria-hidden="true">
        {kinds.map((k) => (
          <span key={k} className="ring-c-bg rounded-[5px] ring-2">
            <ObjectIcon icon={config.objects[k]?.icon} index={objectIndex(config, k)} size="sm" />
          </span>
        ))}
      </span>
      {records.length === 1 ? '1 record' : `${records.length} records`}
    </button>
  )
}

function SourcesList({ records, config }: { records: RecordRef[]; config: PublicCrmConfig }) {
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    list.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  return (
    <ul ref={list} aria-label="Records used" className="mt-2 grid scroll-mb-4 gap-1 sm:grid-cols-2">
      {records.map((r) => {
        const obj = config.objects[r.objectKey]
        return (
          <li key={`${r.objectKey}:${r.id}`}>
            <Link
              to="/$object/$id"
              params={{ object: r.objectKey, id: r.id }}
              className={cx(
                'flex h-11 items-center gap-2.5 rounded-xl border border-c-line px-3 text-[14px] hover:bg-c-hov',
                focusRing,
              )}
            >
              <ObjectIcon icon={obj?.icon} index={objectIndex(config, r.objectKey)} />
              <span className="min-w-0 flex-1 truncate">
                {r.title || `Untitled ${obj?.label.toLowerCase() ?? ''}`}
              </span>
              <span className="text-c-fg3 shrink-0 text-xs">{obj?.label}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

type Block =
  | { kind: 'text'; text: string; at: number }
  | { kind: 'steps'; steps: ToolStep[]; at: number }

export function AssistantMessage({
  parts,
  config,
  live,
  last,
  onRegenerate,
}: {
  parts: MessagePart[]
  config: PublicCrmConfig
  /** The reply is still arriving. */
  live: boolean
  /** The newest reply: its actions are always shown. */
  last: boolean
  onRegenerate?: () => void
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false)

  const blocks = useMemo(() => {
    const out: Block[] = []

    parts.forEach((p, at) => {
      const [text] = textOfPart(p)

      if (text?.trim()) {
        out.push({ kind: 'text', text, at })
      } else if (isToolPart(p)) {
        const step = toolStep(p, config.objects, live)
        const prev = out.at(-1)

        // Calls made one after another read as one run of steps.
        if (prev?.kind === 'steps') {
          prev.steps.push(step)
        } else {
          out.push({ kind: 'steps', steps: [step], at })
        }
      }
    })

    return out
  }, [parts, config.objects, live])

  const text = textOf(parts)

  const records = useMemo(
    () => (live ? [] : recordsFrom(parts, config.objects)),
    [parts, config.objects, live],
  )

  return (
    <div className="group/reply">
      <h2 className="sr-only">{config.assistant?.name ?? 'Assistant'} said:</h2>
      {blocks.map((b) =>
        b.kind === 'text' ? (
          <Reply key={b.at} text={b.text} />
        ) : (
          <ToolSteps key={b.at} steps={b.steps} />
        ),
      )}
      {!live && (text || records.length > 0) && (
        <div
          className={cx(
            'mt-1 -ml-1.5 flex items-center gap-0.5',
            !last &&
              'opacity-0 transition-opacity group-hover/reply:opacity-100 focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100',
          )}
        >
          {text && <CopyButton text={text} label="Copy reply" />}
          {onRegenerate && (
            <ActionButton label="Regenerate" onClick={onRegenerate}>
              <RotateCw />
            </ActionButton>
          )}
          {records.length > 0 && (
            <SourcesButton
              records={records}
              config={config}
              open={sourcesOpen}
              onToggle={() => setSourcesOpen(!sourcesOpen)}
            />
          )}
        </div>
      )}
      {sourcesOpen && records.length > 0 && <SourcesList records={records} config={config} />}
    </div>
  )
}
