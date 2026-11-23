/**
 * Guides: short tours that show people around the CRM, one place at a time.
 *
 * A guide is a few steps that belong to one place (a list, a record, the Tasks
 * page). Each is offered once, the first time someone is in its place, and any
 * of them can be replayed from the Help menu. The ones here ship with the
 * framework and take their words from the config's labels; an app replaces,
 * turns off or adds guides under `guides` in crm.config.json (docs/guides.md).
 *
 * Pure: no server imports and no Zod, so the browser and the tests can use it.
 * The interface is `src/crm/ui/guides.tsx`; what each person has seen is kept
 * by `src/server/guides.ts`.
 */

export type GuideStep = {
  title: string
  /** Plain text. `{record}`, `{records}`, `{Record}`, `{Records}` and `{app}` are filled in. */
  body: string
  /**
   * The anchor to point at: the `data-guide` value of something on the page.
   * With several, the first one on the page is used. A step whose anchors are
   * all missing is left out, unless `keep` is set.
   */
  target?: string | string[]
  /** Show the step without a pointer when its anchor is not on the page. */
  keep?: boolean
}

export type Guide = {
  id: string
  title: string
  /** The place the guide belongs to: see `inPlace`. */
  where: string
  steps: GuideStep[]
}

/** What an app writes under `guides` in its config: `where` may be left out when replacing a built-in guide. */
export type GuideInput = { title: string; where?: string; steps: GuideStep[] }

/** The parts of the CRM config the guides read. */
export type GuideConfig = {
  app: { name: string }
  objects: Record<
    string,
    {
      label: string
      labelPlural: string
      /** Only the names are read: a `field:<key>` anchor has to name one. */
      fields: Record<string, { type: string }>
      views: { id: string; type: string }[]
    }
  >
  files?: { label: string }
  guides?: Record<string, false | GuideInput>
}

/** Stored in place of a guide's id when someone asked not to be offered guides at all. */
export const NO_OFFERS = '*'

/** How a guide ended for someone. Either way it is not offered to them again. */
export const OUTCOMES = ['finished', 'dismissed'] as const
export type Outcome = (typeof OUTCOMES)[number]

/** The pages that are not an object's list or record. */
export const PAGES = [
  'home',
  'tasks',
  'notes',
  'files',
  'reports',
  'workflows',
  'integrations',
  'assistant',
] as const
export type Page = (typeof PAGES)[number]

const isPage = (name: string): name is Page => PAGES.some((page) => page === name)

/** Where someone is in the CRM. */
export type Place = {
  page: Page | 'list' | 'record' | 'other'
  /** The object whose list or record is open. */
  object?: string
  /** The list is showing a board view. */
  board?: boolean
  /** Search (Cmd+K) is open over the page. */
  search?: boolean
}

/** The place a page address is: `/` is home, `/deals` a list, `/deals/<id>` a record. */
export function placeOf(pathname: string, objects: Record<string, { label: string }>): Place {
  const parts = pathname.split('/').filter(Boolean)
  const [first, second] = parts

  if (first === undefined) {
    return { page: 'home' }
  }

  if (parts.length === 1 && isPage(first)) {
    return { page: first }
  }

  if (Object.hasOwn(objects, first)) {
    if (parts.length === 1) {
      return { page: 'list', object: first }
    }

    if (parts.length === 2 && second) {
      return { page: 'record', object: first }
    }
  }

  return { page: 'other' }
}

const SCOPED = ['list', 'board', 'record'] as const
const isScoped = (kind: string) => SCOPED.some((scoped) => scoped === kind)

/**
 * Reads a `where`: `anywhere`, `search`, a page (`home`, `tasks`, ...), or
 * `list`, `board` and `record`, each optionally for one object (`list:deals`).
 */
export function parseWhere(where: string): { kind: string; object?: string } | null {
  const [kind = '', object, ...rest] = where.split(':')

  if (rest.length > 0) {
    return null
  }

  if (isScoped(kind)) {
    return object === '' ? null : { kind, object }
  }

  if (object !== undefined) {
    return null
  }

  if (kind === 'anywhere' || kind === 'search' || isPage(kind)) {
    return { kind }
  }

  return null
}

/** Whether a guide for `where` belongs to the place someone is in. */
export function inPlace(where: string, place: Place): boolean {
  const at = parseWhere(where)

  if (!at) {
    return false
  }

  // Search covers the page: while it is open, only its own guide belongs.
  if (place.search || at.kind === 'search') {
    return !!place.search && at.kind === 'search'
  }

  if (at.kind === 'anywhere') {
    return true
  }

  if (at.object !== undefined && at.object !== place.object) {
    return false
  }

  if (at.kind === 'board') {
    return place.page === 'list' && !!place.board
  }

  return at.kind === place.page
}

const targetsOf = (step: GuideStep): string[] =>
  step.target === undefined ? [] : [step.target].flat()

/** The steps of a guide that can be shown, given which anchors are on the page. */
export function shownSteps(guide: Guide, present: (anchor: string) => boolean): GuideStep[] {
  return guide.steps.filter((step) => {
    const targets = targetsOf(step)
    return targets.length === 0 || step.keep === true || targets.some(present)
  })
}

/** The anchor a step points at: the first of its targets that is on the page. */
export function anchorOf(
  step: GuideStep,
  present: (anchor: string) => boolean,
): string | undefined {
  return targetsOf(step).find(present)
}

/**
 * The guide to offer someone where they are: the first one, in order, that
 * belongs to the place, that they have not finished or dismissed, and that has
 * something to show. One at a time, so nobody is handed a queue.
 */
export function guideToOffer(
  guides: Guide[],
  place: Place,
  seen: ReadonlySet<string>,
  opts: { offers: boolean; present: (anchor: string) => boolean },
): Guide | null {
  if (!opts.offers || seen.has(NO_OFFERS)) {
    return null
  }

  for (const guide of guides) {
    if (seen.has(guide.id) || !inPlace(guide.where, place)) {
      continue
    }

    if (shownSteps(guide, opts.present).length > 0) {
      return guide
    }
  }

  return null
}

/** "Contacts", "Contacts and Deals", "Contacts, Companies and Deals", "Contacts, Companies, Deals and more". */
function listed(words: string[], max = 4): string {
  const shown = words.length > max ? [...words.slice(0, max - 1), 'more'] : words

  if (shown.length <= 1) {
    return shown[0] ?? ''
  }

  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** Fills the placeholders in a guide's words from the config and the object in view. */
export function fill(text: string, config: GuideConfig, place?: Place): string {
  const obj = place?.object ? config.objects[place.object] : undefined
  const one = obj?.label ?? 'Record'
  const many = obj?.labelPlural ?? 'Records'

  const words = new Map([
    ['app', config.app.name],
    ['Record', one],
    ['Records', many],
    ['record', one.toLowerCase()],
    ['records', many.toLowerCase()],
  ])

  return text.replace(
    /\{(app|Record|Records|record|records)\}/g,
    (_, key: string) => words.get(key) ?? '',
  )
}

/** The guides every CRM starts with. Written to be true of any config. */
export function builtInGuides(config: GuideConfig): Guide[] {
  const kinds = listed(Object.values(config.objects).map((o) => o.labelPlural))
  const firstKind = Object.values(config.objects)[0]?.labelPlural.toLowerCase() ?? 'records'
  const library = config.files?.label

  return [
    {
      id: 'welcome',
      title: 'A quick look around',
      where: 'anywhere',
      steps: [
        {
          title: 'Welcome to {app}',
          body: `This is where the team keeps its ${kinds || 'records'}. Five short steps show you where things are. You can close this at any point and carry on working.`,
        },
        {
          title: 'Everything is in the sidebar',
          body: `Each kind of record has its own list: ${kinds || 'they are listed here'}. Tasks, Notes, Files and Reports sit above them, and records you star appear under Favorites.`,
          target: ['nav-records', 'show-sidebar'],
          keep: true,
        },
        {
          title: 'Search finds anything',
          body: 'Press ⌘K (Ctrl+K on Windows) on any page to find a record, note, email or file from a few letters of its name.',
          target: ['nav-search', 'open-search'],
          keep: true,
        },
        {
          title: 'Ask in plain words',
          body: 'Ask opens the assistant. Ask it a question about your records, or tell it what to update.',
          target: 'ask',
        },
        {
          title: 'Guides are under Help',
          body: 'Each part of the CRM offers a short guide like this one the first time you open it. Help, at the bottom of the sidebar, lists them all and replays any of them.',
          target: 'help',
          keep: true,
        },
      ],
    },
    {
      id: 'home',
      title: 'Your Home page',
      where: 'home',
      steps: [
        {
          title: 'Start with a question',
          body: 'Type a question or an instruction and press Enter. The answer opens in the assistant.',
          target: 'home-ask',
        },
        {
          title: 'What the CRM holds',
          body: 'One tile for each kind of record, with how many there are. Click a tile to open its list.',
          target: 'home-counts',
        },
        {
          title: 'Your tasks',
          body: 'The open tasks assigned to you, soonest first. Tick the circle when one is done, or add one with +.',
          target: 'home-tasks',
        },
        {
          title: 'What happened lately',
          body: 'The latest changes anyone made. Click a line to open that record.',
          target: 'home-activity',
        },
      ],
    },
    {
      id: 'search',
      title: 'Searching',
      where: 'search',
      steps: [
        {
          title: 'One box for everything',
          body: 'Type a few letters. Records match as you type, small typos included. Notes, emails, calls, tasks and file names follow a moment after you stop.',
          target: 'search-box',
        },
        {
          title: 'Before you type',
          body: 'With the box empty you get the records you opened most recently and your favorites. Pages, views and “New …” can be found by name too.',
          target: 'search-results',
        },
        {
          title: 'Narrow it down',
          body: `Type the start of a kind of record, such as “${firstKind.slice(0, 4)}”, and press Tab to search only ${firstKind}. Backspace in the empty box searches everything again.`,
          target: 'search-box',
        },
        {
          title: 'Keys',
          body: 'Up and Down move through the results, Enter opens one, ⌘Enter opens it in a new tab, and Esc closes search.',
          target: ['search-keys', 'search-box'],
        },
      ],
    },
    {
      id: 'list',
      title: 'Working in a list',
      where: 'list',
      steps: [
        {
          title: 'Views',
          body: 'A view is a saved way of looking at this list: which columns, which filters, in what order. Switch views here, or make a new table or board.',
          target: 'view-menu',
        },
        {
          title: 'Choose what you see',
          body: "View settings shows, hides and reorders the columns of a table, or picks the fields on a board's cards. These changes are saved to the view straight away.",
          target: 'view-settings',
        },
        {
          title: 'Edit without opening',
          body: 'Click a cell to change it where it is. Click the name in the first column to open the {record}. Tick rows to delete several at once.',
          target: 'table',
        },
        {
          title: 'Add a {record}',
          body: 'This opens a short form. A {record} added while the list is filtered starts out matching the filters, so it shows up where you added it.',
          target: 'new-record',
        },
        {
          title: 'Spreadsheets in and out',
          body: 'Import a CSV file to add many at once, or export what is shown as a CSV.',
          target: 'import-export',
        },
      ],
    },
    {
      id: 'filters',
      title: 'Filtering and sorting',
      where: 'list',
      steps: [
        {
          title: 'Type to search or filter',
          body: 'Typing narrows the list as you go. When what you type reads as a filter, such as a stage, a person, “over 5000” or “last 30 days”, the box offers it: press Tab to take it. Press / to jump here.',
          target: 'filter-box',
        },
        {
          title: 'Filter by any field',
          body: 'Filter, or the F key, lists every field, including fields of related records. Each filter in force shows here: click one to change it, or its × to remove it.',
          target: ['filter-add', 'filter-bar'],
        },
        {
          title: 'Sort',
          body: "Sort by any column, then by up to two more. A column's heading has the same choices, and can also filter by or hide that column.",
          target: 'sort',
        },
        {
          title: 'Trying a filter changes nothing',
          body: "Filters and sorting stay yours until you save them: the page address holds them, so you can send a filtered list as a link. Once you change something, Save appears beside the view's name. It keeps the change in the view, or as a new view for everyone or only for you. Reset puts the view back.",
          target: ['save-view', 'view-menu'],
        },
        {
          title: 'Totals',
          body: 'The foot of a table counts what is shown. Click the foot of a column to add a sum, an average or another calculation.',
          target: 'table-foot',
        },
      ],
    },
    {
      id: 'board',
      title: 'Working on a board',
      where: 'board',
      steps: [
        {
          title: 'A column for each step',
          body: 'A board groups this list by one field: each column is one of its values, and each card is one {record}.',
          target: 'board',
        },
        {
          title: 'Drag to move',
          body: "Drag a card to another column to change that field. It is saved at once and noted on the {record}'s timeline.",
          target: 'board',
        },
        {
          title: 'Add in a column',
          body: 'The + at the top of a column adds a {record} that starts in that column.',
          target: 'board-add',
        },
        {
          title: 'What a card shows',
          body: 'View settings picks the field the board is grouped by and the fields shown on each card.',
          target: 'view-settings',
        },
      ],
    },
    {
      id: 'record',
      title: 'A record page',
      where: 'record',
      steps: [
        {
          title: 'Everything about one {record}',
          body: 'Its fields are on this side. Click any value to change it: it is saved when you press Enter or click away, and Esc leaves it as it was.',
          target: 'record-details',
        },
        {
          title: 'The whole story',
          body: 'Overview shows the latest. Activity is the full timeline: every change, call, meeting, email and note, newest first. The other tabs hold emails, notes, tasks and the records linked to this one.',
          target: 'record-tabs',
        },
        {
          title: 'Keep it close',
          body: 'Star a {record} to keep it under Favorites in the sidebar.',
          target: 'favorite',
        },
        {
          title: 'Back, previous and next',
          body: '× goes back to the list. When you opened the {record} from a list, the arrows beside it step to the one before and the one after.',
          target: ['record-nav', 'record-back'],
        },
        {
          title: 'More',
          body: 'This menu holds the actions set up for this kind of record, and Delete.',
          target: 'more-actions',
        },
      ],
    },
    {
      id: 'recordActions',
      title: 'Keeping a record up to date',
      where: 'record',
      steps: [
        {
          title: 'Write an email',
          body: 'Compose email writes to the address on this {record}. It goes out from your own mailbox when one is connected, and a copy is kept on the Emails tab.',
          target: 'compose-email',
        },
        {
          title: 'Log a call or a meeting',
          body: 'Say when it was, how it went and what was said. It goes on the timeline and counts in Reports.',
          target: 'log-call',
        },
        {
          title: 'Add a note',
          body: 'A note has a title and as much text as you need. Search finds notes by what they say.',
          target: 'add-note',
        },
        {
          title: 'Add a task',
          body: 'Give it a due date and a person. It appears on their Tasks page and on their Home page.',
          target: 'add-task',
        },
        {
          title: 'Files',
          body: "The Files tab is this {record}'s folder. Drop files in, or make folders to sort them.",
          target: 'tab:files',
        },
      ],
    },
    {
      id: 'tasks',
      title: 'Tasks',
      where: 'tasks',
      steps: [
        {
          title: "Yours, or everyone's",
          body: "My tasks are the ones assigned to you. All tasks shows the whole team's.",
          target: 'tasks-scope',
        },
        {
          title: 'Add a task',
          body: "Give it a due date and a person. To attach a task to a record, add it from that record's page.",
          target: 'new-task',
        },
        {
          title: 'Work through them',
          body: "Tasks are grouped by what is due today (or overdue), what is coming up and what has no date. Tick the circle to complete one, and click a record's name to open it.",
          target: 'tasks-list',
        },
      ],
    },
    {
      id: 'notes',
      title: 'Notes',
      where: 'notes',
      steps: [
        {
          title: 'Every note in one place',
          body: "Notes written on records and notes written here are all on this page. A note's card names the record it belongs to. Click a card to read or change it.",
          target: 'notes-list',
          keep: true,
        },
        {
          title: 'Write a note',
          body: "A note written here stands on its own. To attach one to a record, write it from that record's page.",
          target: 'new-note',
        },
      ],
    },
    {
      id: 'files',
      title: 'Files',
      where: 'files',
      steps: [
        {
          title: 'Every folder in one place',
          body: library
            ? `Each record that takes files has its own folder here, and ${library} holds what belongs to the business as a whole. The path along the top shows where you are.`
            : 'Each record that takes files has its own folder here. The path along the top shows where you are.',
          target: 'files-path',
        },
        {
          title: 'Find a file',
          body: 'Search all files by name, whichever folder they are in. The buttons beside it switch between a list and a grid.',
          target: 'files-search',
        },
        {
          title: 'Add files and folders',
          body: 'New folder and Upload add to the folder you are in. You can also drop files onto the page, or right-click a folder or file for more.',
          target: 'files-add',
        },
      ],
    },
    {
      id: 'reports',
      title: 'Reports',
      where: 'reports',
      steps: [
        {
          title: 'Who did what',
          body: "Team activity counts each person's calls, emails, meetings, completed tasks and notes. Choose the period at the top right of the table, or export it as a CSV.",
          target: 'report-activity',
        },
        {
          title: 'The charts',
          body: 'Below it: how many records were added each week, and each kind of record broken down by its stage or status, with money totals where there is an amount.',
          target: 'report-charts',
        },
      ],
    },
    {
      id: 'workflows',
      title: 'Workflows',
      where: 'workflows',
      steps: [
        {
          title: 'What runs by itself',
          body: "Automations run when a record is created or changed. Record actions are the ones you run yourself from a record's ⋯ menu. Sequences are emails sent over several days.",
          target: 'workflow-lists',
        },
        {
          title: 'Is it switched on?',
          body: 'A green dot means it is connected. Without it, workflow runs are skipped and emails are logged without being sent. If sequences need a scheduled job on this server, this line says so.',
          target: 'workflow-status',
        },
        {
          title: 'What ran',
          body: 'Recent runs lists what was run lately and on which record. Click a line to open the record.',
          target: 'workflow-runs',
        },
      ],
    },
    {
      id: 'integrations',
      title: 'Your mailbox and connections',
      where: 'integrations',
      steps: [
        {
          title: 'Your mailboxes',
          body: 'The CRM can log your email and meetings with people who are already in it, and send from your own address. It uses the account you sign in with, and any mailbox you connect here.',
          target: 'mailboxes',
        },
        {
          title: 'What is kept',
          body: 'Only mail and meetings with people already in the CRM are kept, as a subject and a short preview. Each person connects their own accounts; nobody else can use yours.',
          target: 'mailbox-privacy',
        },
        {
          title: 'Check it any time',
          body: 'The envelope at the bottom of the sidebar shows what your mailbox allows and when it was last read.',
          target: 'mailbox',
          keep: true,
        },
      ],
    },
    {
      id: 'assistant',
      title: 'The assistant',
      where: 'assistant',
      steps: [
        {
          title: 'Ask about your records',
          body: 'Start a chat and ask in plain words. The assistant can search, read and update records, and add notes to their timelines.',
          target: ['assistant-new', 'assistant-box'],
        },
        {
          title: 'Check what it did',
          body: "Under each reply you can open the steps it took and the records it used. Anything it changes is also noted on that record's timeline, the same as a change you make yourself.",
          target: ['assistant-thread', 'assistant-new'],
        },
        {
          title: 'Earlier chats',
          body: 'Your chats are kept in this list. Click one to pick it up again.',
          target: 'assistant-chats',
        },
      ],
    },
  ]
}

/**
 * The guides of one CRM, in the order they are offered:
 *
 * 1. guides for anywhere (the welcome), so a new person meets the CRM before a page;
 * 2. guides for one object (`list:deals`, `record:jobs`), because what an app
 *    says about its own records matters more than how lists work in general;
 * 3. the rest.
 *
 * Within each, the built-in guides come first, with the app's replacements in
 * their place and the ones it turned off left out, then the guides the app
 * added, in the order the config lists them.
 */
export function resolveGuides(config: GuideConfig): Guide[] {
  const own = config.guides ?? {}
  const builtIn = builtInGuides(config)
  const known = new Set(builtIn.map((g) => g.id))
  const guides: Guide[] = []

  for (const guide of builtIn) {
    const mine = Object.hasOwn(own, guide.id) ? own[guide.id] : undefined

    if (mine === false) {
      continue
    }

    guides.push(
      mine
        ? { id: guide.id, title: mine.title, where: mine.where ?? guide.where, steps: mine.steps }
        : guide,
    )
  }

  for (const [id, mine] of Object.entries(own)) {
    if (known.has(id) || mine === false || !mine.where) {
      continue
    }

    guides.push({ id, title: mine.title, where: mine.where, steps: mine.steps })
  }

  const rank = (guide: Guide) => {
    const at = parseWhere(guide.where)
    return at?.kind === 'anywhere' ? 0 : at?.object !== undefined ? 1 : 2
  }

  // A stable sort: guides of the same rank keep the order above.
  return guides.toSorted((a, b) => rank(a) - rank(b))
}

/** Every anchor the framework's pages carry (`data-guide`), besides the patterns in `isAnchor`. */
export const ANCHORS = [
  // The frame
  'sidebar',
  'nav-search',
  'nav-records',
  'nav-favorites',
  'show-sidebar',
  'open-search',
  'ask',
  'help',
  'mailbox',
  'theme',
  // Home
  'home-ask',
  'home-counts',
  'home-tasks',
  'home-activity',
  // Search
  'search-box',
  'search-results',
  'search-keys',
  // A list
  'view-menu',
  'view-settings',
  'save-view',
  'import-export',
  'new-record',
  'filter-bar',
  'filter-box',
  'filter-add',
  'sort',
  'table',
  'table-foot',
  'board',
  'board-add',
  // A record
  'record-back',
  'record-nav',
  'favorite',
  'record-actions',
  'compose-email',
  'log-call',
  'log-meeting',
  'add-note',
  'add-task',
  'more-actions',
  'record-details',
  'record-tabs',
  // Other pages
  'tasks-scope',
  'new-task',
  'tasks-list',
  'new-note',
  'notes-list',
  'files-path',
  'files-search',
  'files-add',
  'report-activity',
  'report-charts',
  'workflow-status',
  'workflow-lists',
  'workflow-runs',
  'mailboxes',
  'mailbox-privacy',
  'assistant-new',
  'assistant-box',
  'assistant-thread',
  'assistant-chats',
] as const

/** The tabs every record page has; a related list's tab is `tab:<objectKey>.<field>`. */
const TABS = ['overview', 'activity', 'emails', 'notes', 'tasks', 'files']

/**
 * Whether a target names an anchor that can exist: one from `ANCHORS`, a field
 * on a record page (`field:<key>`), a sidebar link (`nav:<objectKey>` or
 * `nav:<page>`), or a record tab (`tab:<id>`).
 */
export function isAnchor(target: string, config: GuideConfig, object?: string): boolean {
  if (ANCHORS.some((anchor) => anchor === target)) {
    return true
  }

  const at = target.indexOf(':')

  if (at < 0) {
    return false
  }

  const kind = target.slice(0, at)
  const name = target.slice(at + 1)

  if (kind === 'field') {
    // Without an object the guide runs on every object's records: the step is left out where the field is missing.
    const fields = object ? config.objects[object]?.fields : undefined
    return /^[a-z][a-zA-Z0-9]*$/.test(name) && (!fields || Object.hasOwn(fields, name))
  }

  if (kind === 'nav') {
    return Object.hasOwn(config.objects, name) || isPage(name)
  }

  if (kind === 'tab') {
    if (TABS.includes(name)) {
      return true
    }

    const [from = '', field = ''] = name.split('.')
    return (
      Object.hasOwn(config.objects, from) &&
      Object.hasOwn(config.objects[from]?.fields ?? {}, field)
    )
  }

  return false
}

export type GuideIssue = { path: (string | number)[]; message: string }

/** What is wrong with the `guides` in a config: checked by `bun run crm:gen` and at start-up. */
export function checkGuides(config: GuideConfig): GuideIssue[] {
  const issues: GuideIssue[] = []
  const builtIn = new Map(builtInGuides({ ...config, guides: {} }).map((g) => [g.id, g]))

  for (const [id, guide] of Object.entries(config.guides ?? {})) {
    const path = ['guides', id]

    if (guide === false) {
      if (!builtIn.has(id)) {
        issues.push({ path, message: `there is no built-in guide "${id}" to turn off` })
      }

      continue
    }

    const where = guide.where ?? builtIn.get(id)?.where

    if (where === undefined) {
      issues.push({
        path: [...path, 'where'],
        message: 'a new guide needs "where": the place it belongs to',
      })

      continue
    }

    const at = parseWhere(where)

    if (!at) {
      issues.push({
        path: [...path, 'where'],
        message: `unknown place "${where}": use anywhere, search, ${PAGES.join(', ')}, or list, board or record (optionally "list:<objectKey>")`,
      })

      continue
    }

    if (at.object !== undefined && !Object.hasOwn(config.objects, at.object)) {
      issues.push({ path: [...path, 'where'], message: `unknown object "${at.object}"` })
      continue
    }

    if (
      at.kind === 'board' &&
      at.object &&
      !config.objects[at.object]?.views.some((v) => v.type === 'board')
    ) {
      issues.push({
        path: [...path, 'where'],
        message: `"${at.object}" has no board view in the config`,
      })
    }

    for (const [i, step] of guide.steps.entries()) {
      for (const target of targetsOf(step)) {
        if (!isAnchor(target, config, at.object)) {
          issues.push({
            path: [...path, 'steps', i, 'target'],
            message: target.startsWith('field:')
              ? `"${target.slice(6)}" is not a field of ${at.object}`
              : `unknown anchor "${target}": see the list in docs/guides.md`,
          })
        }
      }
    }
  }

  return issues
}

/** Where a guide can be replayed: a page, or an object's list (with the view to open for a board). */
export type GuideHome = {
  page?: Page
  object?: string
  view?: string
  /** The guide can't start on arrival: a record has to be opened, or search has to be open. */
  needs?: 'record' | 'search'
}

/**
 * Where to go to replay a guide from somewhere else. A `record` guide has no
 * address of its own (it needs a record), so it gets the object's list and
 * `needs: "record"`. Empty when the guide runs wherever you are.
 */
export function homeOf(guide: Guide, config: GuideConfig): GuideHome {
  const at = parseWhere(guide.where)
  const keys = Object.keys(config.objects)

  if (!at || at.kind === 'anywhere') {
    return {}
  }

  if (at.kind === 'search') {
    return { needs: 'search' }
  }

  if (isPage(at.kind)) {
    return { page: at.kind }
  }

  if (at.kind === 'board') {
    const object =
      at.object ?? keys.find((k) => config.objects[k]?.views.some((v) => v.type === 'board'))

    return {
      object,
      view: object ? config.objects[object]?.views.find((v) => v.type === 'board')?.id : undefined,
    }
  }

  const object = at.object ?? keys[0]
  return at.kind === 'record' ? { object, needs: 'record' } : { object }
}
