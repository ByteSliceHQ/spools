import { Link, useRouterState } from '@tanstack/react-router'
import {
  BarChart3,
  CheckSquare,
  ChevronDown,
  FileText,
  FolderOpen,
  Home,
  type LucideIcon,
  Mail,
  MessageCircle,
  Moon,
  PanelLeft,
  Plug,
  Search,
  Star,
  Sun,
  Workflow,
} from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import type { PublicCrmConfig } from '../config'
import { requestedScopes } from '../mailbox'
import { useAuth } from './auth'
import { GuideHelp, type GuideProgress, GuideProvider } from './guides'
import { ObjectIcon } from './icons'
import { cx, IconButton, Kbd } from './kit'
import { MailboxDialog } from './mailbox'
import { SearchPalette } from './search'
import { searchIndex } from './session'

type Favorite = { objectKey: string; recordId: string; title: string }
type Theme = 'light' | 'dark'

const ShellContext = createContext<{
  openPalette: () => void
  sidebarOpen: boolean
  toggleSidebar: () => void
  /** Where a page with a sidebar of its own puts it; null while the sidebar is hidden or is the CRM's. */
  panel: HTMLElement | null
} | null>(null)

/** The frame a CRM page sits in: its sidebar and search. Null outside the shell. */
export const useShell = () => useContext(ShellContext)

/**
 * Pages whose own list takes the place of the CRM's navigation in the sidebar,
 * the way a chat app's sidebar is its conversations. The page fills
 * `useShell().panel` (with a way back to the CRM in it); the header and the
 * footer stay the shell's.
 */
const OWN_SIDEBAR = new Set(['/assistant'])

/** Position of each object in the config: decides its icon colour everywhere. */
export const objectIndex = (config: PublicCrmConfig, key: string) =>
  Math.max(0, Object.keys(config.objects).indexOf(key))

/** Below this width the sidebar opens over the page instead of beside it. */
const NARROW = '(max-width: 767px)'

/** The CRM frame: sidebar navigation, theme, and search (Cmd+K). */
export function CrmShell({
  config,
  user,
  favorites,
  dueTasks,
  guides,
  children,
}: {
  config: PublicCrmConfig
  user: { name: string; email: string }
  favorites: Favorite[]
  dueTasks: number
  /** What this person has seen of the guides (src/crm/guides.ts). */
  guides: GuideProgress
  children: ReactNode
}) {
  const { AccountButton } = useAuth()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [mailboxOpen, setMailboxOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [theme, setTheme] = useState<Theme>('light')
  const [narrow, setNarrow] = useState(false)
  const [panel, setPanel] = useState<HTMLElement | null>(null)

  // Restore the saved theme (or follow the system) once we're in the browser.
  useEffect(() => {
    const saved = window.localStorage.getItem('crm-theme')

    if (saved === 'light' || saved === 'dark') {
      setTheme(saved)
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark')
    }

    // On a phone the sidebar would take most of the screen: it starts closed, whatever was chosen on a desk.
    const isNarrow = window.matchMedia(NARROW).matches
    setNarrow(isNarrow)
    setSidebarOpen(!isNarrow && window.localStorage.getItem('crm-sidebar') !== 'closed')
    // Fetch what search matches against once the page has settled, so the first search is instant.
    const timer = setTimeout(() => void searchIndex.refresh().catch(() => undefined), 1500)
    return () => clearTimeout(timer)
  }, [])

  // Choosing a page on a phone puts the sidebar away again. So does choosing a chat,
  // which changes only what follows the "?".
  const path = useRouterState({ select: (s) => s.location.pathname })
  const address = useRouterState({ select: (s) => s.location.href })

  // Runs when the page changes.
  useEffect(() => {
    if (window.matchMedia(NARROW).matches) {
      setSidebarOpen(false)
    }
  }, [address])

  const ownSidebar = OWN_SIDEBAR.has(path)

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    window.localStorage.setItem('crm-theme', next)
  }

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      if (!window.matchMedia(NARROW).matches) {
        window.localStorage.setItem('crm-sidebar', open ? 'closed' : 'open')
      }

      return !open
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const shell = useMemo(
    () => ({ openPalette: () => setPaletteOpen(true), sidebarOpen, toggleSidebar, panel }),
    [sidebarOpen, toggleSidebar, panel],
  )

  const openPalette = useCallback(() => setPaletteOpen(true), [])

  // A guide started from Help on a phone needs the page, which the sidebar is covering.
  const clearForGuide = useCallback(() => {
    if (window.matchMedia(NARROW).matches) {
      setSidebarOpen(false)
    }
  }, [])

  return (
    <ShellContext value={shell}>
      <div className={cx('crm flex h-screen overflow-hidden', theme === 'dark' && 'dark')}>
        <GuideProvider
          config={config}
          who={user.email}
          progress={guides}
          searchOpen={paletteOpen}
          openSearch={openPalette}
          onStart={clearForGuide}
        >
          {sidebarOpen && narrow && (
            <button
              type="button"
              aria-label="Close sidebar"
              onClick={toggleSidebar}
              className="fixed inset-0 z-40 bg-black/35"
            />
          )}
          {sidebarOpen && (
            <aside
              data-guide="sidebar"
              className={cx(
                'flex shrink-0 flex-col border-r border-c-line bg-c-panel',
                narrow
                  ? 'fixed inset-y-0 left-0 z-50 w-[260px] shadow-2xl'
                  : ownSidebar
                    ? 'w-[260px]'
                    : 'w-[220px]',
              )}
            >
              <div className="flex h-11 items-center gap-2 px-3">
                <span className="bg-c-accent flex size-5 items-center justify-center rounded-md text-[11px] font-bold text-white">
                  {config.app.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {config.app.name}
                </span>
                <IconButton label="Hide sidebar" className="size-6" onClick={toggleSidebar}>
                  <PanelLeft className="size-3.5" />
                </IconButton>
              </div>

              {ownSidebar ? (
                <div ref={setPanel} className="flex min-h-0 flex-1 flex-col" />
              ) : (
                <>
                  <div className="px-2 pb-2">
                    <button
                      type="button"
                      onClick={() => setPaletteOpen(true)}
                      data-guide="nav-search"
                      className="border-c-line2 bg-c-raised text-c-fg2 hover:text-c-fg flex h-7 w-full items-center gap-2 rounded-lg border px-2"
                    >
                      <Search className="size-3.5" />
                      <span className="flex-1 text-left">Search</span>
                      <Kbd>⌘K</Kbd>
                    </button>
                  </div>

                  <nav className="flex-1 overflow-y-auto px-2 pb-3">
                    <NavLink to="/" exact icon={Home} label="Home" />
                    <NavLink to="/tasks" icon={CheckSquare} label="Tasks" badge={dueTasks} />
                    <NavLink to="/notes" icon={FileText} label="Notes" />
                    <NavLink to="/files" icon={FolderOpen} label="Files" />
                    <NavLink to="/reports" icon={BarChart3} label="Reports" />
                    <NavLink to="/workflows" icon={Workflow} label="Workflows" />
                    <NavLink to="/integrations" icon={Plug} label="Integrations" />

                    {favorites.length > 0 && (
                      <Section title="Favorites" anchor="nav-favorites">
                        {favorites.map((f) => (
                          <Link
                            key={`${f.objectKey}:${f.recordId}`}
                            to="/$object/$id"
                            params={{ object: f.objectKey, id: f.recordId }}
                            className={navItem}
                            activeProps={navActive}
                          >
                            <Star
                              className="size-3.5 shrink-0 text-amber-500"
                              fill="currentColor"
                              strokeWidth={0}
                            />
                            <span className="truncate">{f.title}</span>
                          </Link>
                        ))}
                      </Section>
                    )}

                    <Section title="Records" anchor="nav-records">
                      {Object.entries(config.objects).map(([key, obj], i) => (
                        <Link
                          key={key}
                          to="/$object"
                          params={{ object: key }}
                          data-guide={`nav:${key}`}
                          className={navItem}
                          activeProps={navActive}
                        >
                          <ObjectIcon icon={obj.icon} index={i} />
                          <span className="truncate">{obj.labelPlural}</span>
                        </Link>
                      ))}
                    </Section>
                  </nav>
                </>
              )}

              <div className="border-c-line relative flex items-center gap-1.5 border-t px-3 py-2">
                <AccountButton scopes={requestedScopes()} />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate font-medium">{user.name}</div>
                  <div className="text-c-fg3 truncate text-[11px]">{user.email}</div>
                </div>
                <GuideHelp />
                <IconButton
                  label="Your mailbox"
                  className="size-6"
                  data-guide="mailbox"
                  onClick={() => setMailboxOpen(true)}
                >
                  <Mail className="size-3.5" />
                </IconButton>
                <IconButton
                  label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                  className="size-6"
                  data-guide="theme"
                  onClick={toggleTheme}
                >
                  {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
                </IconButton>
              </div>
            </aside>
          )}

          {/* Focusable from code only: a guide that ends hands the keyboard back to the page. */}
          <main
            tabIndex={-1}
            className="bg-c-bg relative flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
          >
            <LoadingBar />
            {children}
          </main>

          {paletteOpen && (
            <SearchPalette
              config={config}
              favorites={favorites}
              onClose={() => setPaletteOpen(false)}
            />
          )}
          <MailboxDialog open={mailboxOpen} onClose={() => setMailboxOpen(false)} />
        </GuideProvider>
      </div>
    </ShellContext>
  )
}

const navItem = 'flex h-7 items-center gap-2 rounded-lg px-2 text-c-fg hover:bg-c-hov'
const navActive = { className: 'bg-c-hov font-medium' }

function NavLink({
  to,
  icon: Icon,
  label,
  badge,
  exact,
}: {
  to: string
  icon: LucideIcon
  label: string
  badge?: number
  exact?: boolean
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      data-guide={`nav:${to === '/' ? 'home' : to.slice(1)}`}
      className={navItem}
      activeProps={navActive}
    >
      <Icon className="text-c-fg2 size-3.5 shrink-0" strokeWidth={2} />
      <span className="flex-1 truncate">{label}</span>
      {!!badge && (
        <span className="bg-c-accent rounded-md px-1 text-[10px] font-semibold text-white tabular-nums">
          {badge}
        </span>
      )}
    </Link>
  )
}

/**
 * A thin bar across the top of the page while the next one is being fetched, so
 * a click is answered at once. It waits a moment first: most pages arrive sooner.
 */
function LoadingBar() {
  const loading = useRouterState({ select: (s) => s.isLoading })
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!loading) {
      setShown(false)
      return undefined
    }

    const timer = setTimeout(() => setShown(true), 120)
    return () => clearTimeout(timer)
  }, [loading])

  if (!shown) {
    return null
  }

  return (
    <div
      role="progressbar"
      aria-label="Loading"
      className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden"
    >
      <div className="crm-loading-bar bg-c-accent h-full w-1/3" />
    </div>
  )
}

function Section({
  title,
  anchor,
  children,
}: {
  title: string
  anchor: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-4" data-guide={anchor}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-c-fg3 hover:text-c-fg2 flex h-6 w-full items-center gap-1.5 rounded-lg px-2 text-xs font-medium"
      >
        <ChevronDown className={cx('size-3 transition-transform', !open && '-rotate-90')} />
        {title}
      </button>
      {open && <div className="mt-0.5 space-y-px">{children}</div>}
    </div>
  )
}

/**
 * The bar at the top of every CRM page: icon and title (or custom `left` content)
 * on the left, page actions and the assistant on the right.
 */
export function TopBar({
  icon,
  title,
  left,
  ask = true,
  flat,
  children,
}: {
  icon?: ReactNode
  title?: string
  left?: ReactNode
  /** The link to the assistant. The assistant's own page leaves it out. */
  ask?: boolean
  /** No line under the bar, for a page that reads as one surface. */
  flat?: boolean
  children?: ReactNode
}) {
  const shell = useContext(ShellContext)
  return (
    <header
      className={cx(
        'flex h-11 shrink-0 items-center gap-2 px-3',
        !flat && 'border-b border-c-line',
      )}
    >
      {shell && !shell.sidebarOpen && (
        <>
          <IconButton label="Show sidebar" data-guide="show-sidebar" onClick={shell.toggleSidebar}>
            <PanelLeft className="size-3.5" />
          </IconButton>
          <IconButton label="Search" data-guide="open-search" onClick={shell.openPalette}>
            <Search className="size-3.5" />
          </IconButton>
        </>
      )}
      {left ?? (
        <div className="flex min-w-0 items-center gap-2 font-medium">
          {icon}
          <span className="truncate">{title}</span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {children}
        {ask && (
          <Link
            to="/assistant"
            data-guide="ask"
            className="border-c-line2 hover:bg-c-hov inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 font-medium"
          >
            <MessageCircle className="size-3.5" /> Ask
          </Link>
        )}
      </div>
    </header>
  )
}
