import { useChat } from '@ai-sdk/react'
import { createSwirlsChatTransport } from '@swirls/sdk/chat/react'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import type { UIMessage } from 'ai'
import { ArrowDown, RotateCw, SquarePen, X } from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { z } from 'zod'

import {
  assistantGreeting,
  assistantName,
  type ChatSession,
  hasContent,
  type MessagePart,
  suggestionsFor,
  titleFrom,
} from '../crm/assistant'
import type { PublicCrmConfig } from '../crm/config'
import {
  AssistantMessage,
  ChatSidebar,
  Composer,
  DeleteChatDialog,
  ThinkingDot,
  UserMessage,
} from '../crm/ui/assistant'
import { Button, IconButton } from '../crm/ui/kit'
import { TopBar, useShell } from '../crm/ui/shell'
import { useCrmConfig } from '../crm/ui/use-crm'
import { createAssistantSessionFn, deleteAssistantSessionFn } from '../server/assistant.functions'

const route = getRouteApi('/_crm/assistant')

/** The JSON body an error may carry: the assistant API and Swirls put the reason in one of these. */
const errorBody = z.object({ error: z.unknown(), message: z.unknown() }).partial()
const sentence = z.string().min(1)

/** Turn whatever the transport threw into a sentence a person can act on. */
function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)

  try {
    const body = errorBody.safeParse(JSON.parse(message))
    const detail = sentence.safeParse(body.data?.error ?? body.data?.message)

    if (detail.success) {
      return detail.data
    }
  } catch {
    // Not JSON: use the message as it is.
  }

  return message || 'Something went wrong'
}

/** A message's parts, as the CRM's chat helpers read them. */
const partsOf = (m: UIMessage): MessagePart[] => m.parts

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The Ask page. Its chats are listed in the sidebar in place of the CRM's
 * navigation (see `OWN_SIDEBAR` in shell.tsx); a new chat is only made once its
 * first message is sent, and is titled from that message.
 */
export function AssistantPage(): ReactNode {
  const state = route.useLoaderData()
  const { session, ask } = route.useSearch()
  const config = useCrmConfig()
  const navigate = route.useNavigate()
  const router = useRouter()
  const shell = useShell()
  const name = assistantName(config)
  // A chat started here shows in the list at once, before Swirls lists it; one deleted goes at once.
  const [started, setStarted] = useState<ChatSession[]>([])
  const [deleted, setDeleted] = useState<string[]>([])
  /** The first message of a chat that is being made. */
  const [pending, setPending] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ChatSession | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const starting = useRef(false)

  const chats = useMemo(() => {
    const listed = new Set(state.sessions.map((s) => s.sessionId))
    return [...started.filter((s) => !listed.has(s.sessionId)), ...state.sessions].filter(
      (s) => !deleted.includes(s.sessionId),
    )
  }, [started, deleted, state.sessions])

  // Only this page's list and transcript: the rest of what the browser remembers stays.
  const refresh = useCallback(
    () => void router.invalidate({ filter: (match) => match.routeId === route.id }),
    [router],
  )

  const start = async (text: string) => {
    const question = text.trim()

    if (!question || pending) {
      return
    }

    setPending(question)
    setProblem(null)

    try {
      const title = titleFrom(question)
      const { sessionId } = await createAssistantSessionFn({ data: { title } })
      setStarted((rows) => [{ sessionId, title, updatedAt: new Date().toISOString() }, ...rows])
      setDraft('')
      await navigate({ search: { session: sessionId, ask: question } })
    } catch (err) {
      setProblem(`Could not start a chat: ${errorText(err)}`)
      setDraft(question)
    } finally {
      setPending(null)
    }
  }

  const newChat = useCallback(() => {
    void navigate({ search: {} }).then(() => composer.current?.focus())
  }, [navigate])

  const remove = async (chat: ChatSession) => {
    setConfirming(null)

    try {
      await deleteAssistantSessionFn({ data: { sessionId: chat.sessionId } })
      setDeleted((ids) => [...ids, chat.sessionId])

      if (chat.sessionId === session) {
        await navigate({ search: {} })
      }

      refresh()
    } catch (err) {
      setProblem(`Could not delete the chat: ${errorText(err)}`)
    }
  }

  // A question handed over from Home (or the address) starts a chat of its own.
  useEffect(() => {
    if (state.configured && ask && !session && !starting.current) {
      starting.current = true
      void start(ask)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Run once per incoming question.
  }, [ask, session, state.configured])

  // Ctrl+Shift+O (Cmd+Shift+O on a Mac) starts a new chat, as in other chat apps.
  useEffect(() => {
    if (!state.configured) {
      return undefined
    }

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        newChat()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [newChat, state.configured])

  return (
    <>
      {shell?.panel &&
        createPortal(
          <ChatSidebar
            configured={state.configured}
            chats={chats}
            current={session}
            onNew={newChat}
            onDelete={setConfirming}
          />,
          shell.panel,
        )}
      <TopBar
        left={<span className="truncate text-[15px] font-medium">{name}</span>}
        ask={false}
        flat
      >
        {state.configured && !shell?.sidebarOpen && (
          <IconButton label="New chat" data-guide="assistant-new" onClick={newChat}>
            <SquarePen className="size-4" />
          </IconButton>
        )}
      </TopBar>
      {problem && (
        <div className="mx-auto w-full max-w-3xl px-4 md:px-6">
          <div
            role="alert"
            className="border-c-danger/30 bg-c-danger/5 text-c-danger mt-2 flex items-start gap-3 rounded-2xl border px-4 py-2.5 text-[14px]"
          >
            <span className="min-w-0 flex-1 break-words">{problem}</span>
            <IconButton
              label="Dismiss"
              className="text-c-danger -my-1 size-7"
              onClick={() => setProblem(null)}
            >
              <X className="size-3.5" />
            </IconButton>
          </div>
        </div>
      )}
      {!state.configured ? (
        <NotConnected ask={ask} />
      ) : session ? (
        <Conversation
          key={session}
          sessionId={session}
          initialMessages={state.messages}
          ask={ask}
          canRegenerate={state.canRegenerate}
          config={config}
          composerRef={composer}
          // Swirls may title a chat after its first reply; pick that up for the list.
          onReplied={refresh}
        />
      ) : pending ? (
        <Thread
          composer={
            <Composer
              value=""
              onChange={() => {}}
              onSend={() => {}}
              busy
              inputRef={composer}
              name={name}
            />
          }
          name={name}
        >
          <UserMessage parts={[{ type: 'text', text: pending }]} />
          <ThinkingDot name={name} />
        </Thread>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 md:justify-center md:pb-[14vh]">
          <div className="flex flex-1 items-center justify-center md:flex-none">
            <h1 className="text-center text-[26px] font-semibold tracking-tight md:text-[28px]">
              {assistantGreeting(config)}
            </h1>
          </div>
          <div className="mx-auto flex w-full max-w-3xl flex-col md:mt-7">
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => void start(draft)}
              busy={false}
              inputRef={composer}
              name={name}
              focusOnMount
            />
            <ul
              aria-label="Suggestions"
              className="order-first mb-3 flex flex-wrap justify-center gap-2 md:order-none md:mt-5 md:mb-0"
            >
              {suggestionsFor(config).map((s) => (
                <li key={s.label}>
                  <button
                    type="button"
                    onClick={() => void start(s.prompt)}
                    className="border-c-line2 text-c-fg2 hover:bg-c-hov hover:text-c-fg focus-visible:ring-c-accent/60 h-9 rounded-full border px-3.5 text-[14px] outline-none focus-visible:ring-2"
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <DeleteChatDialog
        chat={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={(c) => void remove(c)}
      />
    </>
  )
}

function NotConnected({ ask }: { ask?: string }) {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-base font-semibold">The assistant isn't connected yet</h1>
      <p className="text-c-fg2 mt-2">
        It runs on Swirls. Deploy the files in <code>swirls/</code> with <code>swirls deploy</code>,
        then set <code>SWIRLS_PROJECT_ID</code> in the app's environment and connect your sign-in
        provider to the Swirls project. See <code>docs/swirls.md</code>.
      </p>
      {ask && (
        <p className="border-c-line text-c-fg2 mt-4 rounded-lg border p-3 text-left">
          Your question: {ask}
        </p>
      )}
    </div>
  )
}

/** A conversation's frame: the messages in a centred column, the composer pinned under them. */
function Thread({
  children,
  composer,
  name,
  scroller,
  onScroll,
  overlay,
}: {
  children: React.ReactNode
  composer: React.ReactNode
  name: string
  scroller?: RefObject<HTMLDivElement | null>
  onScroll?: () => void
  overlay?: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
          <div
            data-guide="assistant-thread"
            className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-4 pt-6 pb-12 md:px-6"
          >
            {children}
          </div>
        </div>
        {overlay}
      </div>
      <div className="mx-auto w-full max-w-3xl px-3 pb-2 md:px-6">
        {composer}
        <p className="text-c-fg3 mt-2 text-center text-xs">
          {name} can make mistakes. Check anything important on the record itself.
        </p>
      </div>
    </div>
  )
}

function Conversation({
  sessionId,
  initialMessages,
  ask,
  canRegenerate,
  config,
  composerRef,
  onReplied,
}: {
  sessionId: string
  initialMessages: UIMessage[]
  ask?: string
  canRegenerate: boolean
  config: PublicCrmConfig
  composerRef: RefObject<HTMLTextAreaElement | null>
  onReplied: () => void
}) {
  const navigate = route.useNavigate()
  const name = assistantName(config)
  const [announce, setAnnounce] = useState('')
  const transport = useMemo(() => createSwirlsChatTransport({ api: '/api/assistant' }), [])

  const { messages, sendMessage, status, error, stop, regenerate, clearError } = useChat({
    id: sessionId,
    messages: initialMessages,
    transport,
    resume: true,
    onFinish: ({ isAbort, isError }) => {
      setAnnounce(isAbort ? 'Reply stopped' : isError ? '' : `${name} replied`)
      onReplied()
    },
  })

  const [input, setInput] = useState('')
  const asked = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  // Follow the reply as it streams, unless the reader has scrolled up to read.
  const pinned = useRef(true)
  const [away, setAway] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'
  const last = messages.at(-1)
  const waiting = busy && (last?.role !== 'assistant' || !hasContent(partsOf(last)))
  const shown = messages.filter((m) => m.role !== 'system' && hasContent(partsOf(m)))
  const lastReply = shown.findLast((m) => m.role === 'assistant')

  // Send the question handed over from Home once, then drop it from the address.
  useEffect(() => {
    if (ask && !asked.current && initialMessages.length === 0) {
      asked.current = true
      void sendMessage({ text: ask })
      void navigate({ search: { session: sessionId }, replace: true })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Run once per conversation.
  }, [])

  // Re-run whenever the transcript changes.
  useLayoutEffect(() => {
    const el = scroller.current

    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, status, error])

  const onScroll = () => {
    const el = scroller.current

    if (!el) {
      return
    }

    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinned.current = near
    setAway(!near)
  }

  const toBottom = () => {
    pinned.current = true
    setAway(false)

    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    })
  }

  const send = () => {
    const text = input.trim()

    if (!text || busy) {
      return
    }

    clearError()
    setAnnounce('')
    pinned.current = true
    void sendMessage({ text })
    setInput('')
  }

  const again = () => {
    clearError()
    setAnnounce('')
    pinned.current = true
    void regenerate()
  }

  return (
    <Thread
      name={name}
      scroller={scroller}
      onScroll={onScroll}
      overlay={
        away && (
          <button
            type="button"
            aria-label="Scroll to the newest message"
            onClick={toBottom}
            className="border-c-line2 bg-c-raised text-c-fg2 hover:text-c-fg focus-visible:ring-c-accent/60 absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border shadow-md outline-none focus-visible:ring-2"
          >
            <ArrowDown className="size-4" />
          </button>
        )
      }
      composer={
        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          busy={busy}
          onStop={() => void stop()}
          inputRef={composerRef}
          name={name}
          focusOnMount
        />
      }
    >
      {shown.length === 0 && !busy && !error && (
        <p className="text-c-fg3 py-10 text-center text-[15px]">
          Nothing has been said in this chat yet.
        </p>
      )}
      {shown.map((m) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} parts={partsOf(m)} />
        ) : (
          <AssistantMessage
            key={m.id}
            parts={partsOf(m)}
            config={config}
            live={busy && m.id === last?.id}
            last={m.id === lastReply?.id}
            // Asking again replaces the newest reply, so it is offered only while that reply is the last thing said.
            onRegenerate={canRegenerate && m.id === last?.id && !busy ? again : undefined}
          />
        ),
      )}
      {waiting && <ThinkingDot name={name} />}
      {error && (
        <div
          role="alert"
          className="border-c-danger/30 bg-c-danger/5 text-c-danger flex items-start gap-3 rounded-2xl border px-4 py-3 text-[14px]"
        >
          <span className="min-w-0 flex-1 break-words">{errorText(error)}</span>
          <Button size="sm" onClick={again}>
            <RotateCw className="size-3" /> Try again
          </Button>
        </div>
      )}
      <p className="sr-only" role="status">
        {busy ? `${name} is replying` : announce}
      </p>
    </Thread>
  )
}
