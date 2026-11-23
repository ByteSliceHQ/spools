# Guides

Guides show people around the CRM. Each is a few short steps about one place (a
list, a record page, the Tasks page), offered once, the first time someone is
there. The first half of this page is what the app does; the second is for
whoever writes or changes guides.

- [What people see](#what-people-see)
- [The built-in guides](#the-built-in-guides)
- [Dismissal](#dismissal)
- [Your own guides](#your-own-guides)
- [Places](#places)
- [Anchors](#anchors)
- [Turning offers off](#turning-offers-off)
- [How it works](#how-it-works)
- [Limits](#limits)

## What people see

**An offer.** The first time someone is in a place that has a guide, a small
card appears in the bottom corner with the guide's name and three choices:
_Show me_, _No thanks_ and _Don't offer guides_. It does not take the keyboard
and nothing under it is blocked. It waits until the page has settled, and
while a dialog is open.

**A guide.** _Show me_ starts it. A card sits beside the thing each step is
about, which is ringed; the rest of the page stays usable. Next and Back are
buttons (Right and Left arrows also work while the card has the keyboard), the
× closes the guide, and so does Esc. On a phone the card is a sheet along the
bottom, or along the top when what it points at is low on the screen. A step
about something the page doesn't have is left out: a record with no email
field has no "Write an email" step.

**Help.** The question mark at the bottom of the sidebar lists every guide,
marks the ones not yet seen as New, and starts any of them again. A guide that
belongs to another page takes you there first. One that needs a record says
"Open any deal and … will start", and starts when you do. The same menu has
_Offer guides as I go_, which turns offers off or back on.

One guide is offered at a time. After an offer is answered or a guide ends,
the page offers nothing more until you go somewhere else, so the next guide for
a place comes on a later visit.

## The built-in guides

In the order they are offered:

| Guide                                                           | Place                   | About                                                                                 |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| A quick look around (`welcome`)                                 | anywhere, first         | The sidebar, search, the assistant, Help                                              |
| Your Home page (`home`)                                         | Home                    | The ask box, record counts, your tasks, recent activity                               |
| Searching (`search`)                                            | Search, when it is open | What it finds, narrowing to one kind of record, keys                                  |
| Working in a list (`list`)                                      | any list                | Views, View settings, editing in place, New, Import / Export                          |
| Filtering and sorting (`filters`)                               | any list                | Type to filter, the Filter button and chips, Sort, Save and Reset, totals             |
| Working on a board (`board`)                                    | a list showing a board  | Columns, dragging, adding in a column, card fields                                    |
| A record page (`record`)                                        | any record              | Details and editing, tabs and the timeline, favourites, previous and next, the ⋯ menu |
| Keeping a record up to date (`recordActions`)                   | any record              | Email, calls and meetings, notes, tasks, files                                        |
| Tasks, Notes, Files, Reports, Workflows (`tasks` … `workflows`) | that page               | What the page holds and how to add to it                                              |
| Your mailbox and connections (`integrations`)                   | Integrations            | Mailboxes, what is kept, the mailbox panel                                            |
| The assistant (`assistant`)                                     | Assistant               | Starting a chat, checking what it changed, earlier chats                              |

Their words use your config's labels: a list guide on `deals` says "deals", and
the welcome names your record types. None is longer than five steps.

## Dismissal

_No thanks_, finishing a guide, or closing it part-way all mean the same
thing: that person is not offered that guide again, in any browser or on any
device. It stays in Help. Leaving the page without answering is not an answer;
the offer comes back the next time they are there.

_Don't offer guides_ stops every offer for that person, including guides added
later, until they turn _Offer guides as I go_ back on.

A guide added later is new to everyone. People who finished the old ones are
offered it the first time they are in its place, and it shows as New in Help.
Changing a guide's words does not offer it again. To offer a rewritten guide
to everyone again, give it a new id.

## Your own guides

Guides are part of [`crm.config.json`](configuration.md), under `guides`, by
id. With a built-in guide's id you replace it; with `false` you turn it off;
with a new id you add one.

```json
"guides": {
  "welcome": {
    "title": "Welcome to Acme",
    "steps": [
      { "title": "Start here", "body": "Your deals are under Deals in the sidebar.", "target": "nav:deals", "keep": true },
      { "title": "Ask for help", "body": "Help, at the bottom of the sidebar, has a guide for each page.", "target": "help", "keep": true }
    ]
  },
  "workflows": false,
  "pipeline": {
    "title": "The sales pipeline",
    "where": "board:deals",
    "steps": [
      { "title": "One column per stage", "body": "Drag a {record} to the next stage as it moves.", "target": "board" },
      { "title": "Add one where it belongs", "body": "The + at the top of a column adds a {record} in that stage.", "target": "board-add" }
    ]
  }
}
```

| Key              | Required     | Description                                                                                                                                                      |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`          | yes          | The guide's name, in the offer and in Help.                                                                                                                      |
| `where`          | for a new id | The [place](#places) it belongs to. A replacement keeps the built-in guide's place unless you set one.                                                           |
| `steps`          | yes          | One to eight steps. Keep it to five or fewer.                                                                                                                    |
| `steps[].title`  | yes          | A few words.                                                                                                                                                     |
| `steps[].body`   | yes          | One or two plain sentences, at most 500 characters. No markup.                                                                                                   |
| `steps[].target` | no           | The [anchor](#anchors) to point at, or a list of them: the first one on the page is used. Without it the step is shown in the corner.                            |
| `steps[].keep`   | no           | Show the step without a pointer when its anchor is not on the page, instead of leaving it out. Use it for things a layout hides, such as the sidebar on a phone. |

In a title or body, `{record}`, `{records}`, `{Record}` and `{Records}` become
the label of the object in view ("deal", "deals", "Deal", "Deals"), or
"record" and "records" on a page that has no object, and `{app}` becomes
`app.name`.

**Order.** The welcome and any other guide for `anywhere` come first. Then
guides for one object (`list:deals`, `record:deals`): what you say about your
own records is offered before how lists work in general. Then the rest.
Within each of the three, built-in guides keep their order and yours follow in
the order the config lists them. `bun run crm:gen` (and `bun run check`) rejects an unknown place,
an object or field the config doesn't have, an anchor that doesn't exist, a
new guide with no `where`, and `false` for an id that is not a built-in guide.

Write a step so that it is true whenever its anchor is on the page. If a step
only makes sense for one object, put it in a guide for that object
(`"where": "record:deals"`) rather than the generic one.

## Places

| `where`                                                                                | The guide belongs to                                              |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `anywhere`                                                                             | Every CRM page. Offered before any other guide.                   |
| `home`, `tasks`, `notes`, `files`, `reports`, `workflows`, `integrations`, `assistant` | That page                                                         |
| `list`, `list:<objectKey>`                                                             | Any object's list, or one object's                                |
| `board`, `board:<objectKey>`                                                           | A list while it shows a board view                                |
| `record`, `record:<objectKey>`                                                         | Any record page, or one object's                                  |
| `search`                                                                               | Search (Cmd+K), while it is open. No other guide is offered then. |

## Anchors

An anchor is a `data-guide` attribute on something in the framework's pages.

| Where        | Anchors                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The frame    | `sidebar`, `nav-search`, `nav-records`, `nav-favorites`, `nav:<objectKey>`, `nav:<page>` (`nav:tasks`), `help`, `mailbox`, `theme`, `ask`; with the sidebar closed, `show-sidebar` and `open-search`                                                                                                                                                                                              |
| Home         | `home-ask`, `home-counts`, `home-tasks`, `home-activity`                                                                                                                                                                                                                                                                                                                                          |
| Search       | `search-box`, `search-results`, `search-keys`                                                                                                                                                                                                                                                                                                                                                     |
| A list       | `view-menu`, `view-settings`, `save-view` (only while there are unsaved filters or sorting), `import-export`, `new-record`, `filter-bar`, `filter-box`, `filter-add`, `sort`; on a table `table` and `table-foot`; on a board `board` and `board-add`                                                                                                                                             |
| A record     | `record-back`, `record-nav` (only when opened from a list), `favorite`, `record-actions`, `compose-email` (only with an email address), `log-call`, `log-meeting`, `add-note`, `add-task`, `more-actions`, `record-details`, `field:<fieldKey>`, `record-tabs`, `tab:overview`, `tab:activity`, `tab:emails`, `tab:notes`, `tab:tasks`, `tab:files`, `tab:<objectKey>.<field>` for a related list |
| Tasks        | `tasks-scope`, `new-task`, `tasks-list`                                                                                                                                                                                                                                                                                                                                                           |
| Notes        | `new-note`, `notes-list`                                                                                                                                                                                                                                                                                                                                                                          |
| Files        | `files-path`, `files-search`, `files-add`                                                                                                                                                                                                                                                                                                                                                         |
| Reports      | `report-activity`, `report-charts`                                                                                                                                                                                                                                                                                                                                                                |
| Workflows    | `workflow-status`, `workflow-lists`, `workflow-runs`                                                                                                                                                                                                                                                                                                                                              |
| Integrations | `mailboxes`, `mailbox-privacy`                                                                                                                                                                                                                                                                                                                                                                    |
| Assistant    | `assistant-new`, `assistant-chats`, `assistant-box`, `assistant-thread`                                                                                                                                                                                                                                                                                                                           |

An anchor that is not on the page is not an error at run time: the step is
left out, and a guide with no steps left is not offered. That is what lets one
guide serve every object. `field:<key>` on a guide for all records
(`"where": "record"`) is accepted for the same reason; on a guide for one
object it must be a field of that object.

## Turning offers off

- **For one person:** _Don't offer guides_ on any offer, or _Offer guides as I
  go_ in Help.
- **For one guide:** `"<id>": false` under `guides`.
- **For everyone:** set `CRM_GUIDES=off` in the environment. Help still lists
  the guides and replays them.
- **In the stubbed-sign-in harness** of a clone of the repository (`bun run dev:e2e`, `bun run demo`) offers
  are off unless you set `CRM_GUIDES=on`, so a guide never appears in the
  middle of a test or a demo.

## How it works

- **What a guide is** and which one is offered where is pure code in
  `packages/spools/src/crm/guides.ts`: the built-in guides, `resolveGuides` (built-in plus the
  config's), `placeOf` and `inPlace`, `guideToOffer`, `shownSteps`, and
  `checkGuides`, which the config schema runs. No server imports and no Zod,
  so the browser uses the same file.
- **What each person has seen** is the `guide_progress` table: one row per
  person and guide, with `finished` or `dismissed`, and a row with guide id
  `*` for "don't offer guides". `packages/spools/src/server/guides.ts` reads and writes it; the
  first outcome recorded for a guide stands.
- **No page asks for it.** The ids a person has seen are part of the session
  (`getCrmSession`), which the browser already has. Offering a guide costs no
  request, and answering one costs a single write in the background.
- **Only your own.** The two server functions (`packages/spools/src/server/guides.functions.ts`)
  take no user id: they use the signed-in person's, which `crmHandler` passes in.
  Only this CRM's guide ids are accepted.
- **An answer is not lost to bad timing.** The browser also keeps each answer
  (in `localStorage`, per person) until the server's own list shows it, and
  sends it again on the next visit. So an answer given just before a reload,
  or while the connection was down, still counts in that browser, and reaches
  the server later.
- **The interface** is `packages/spools/src/crm/ui/guides.tsx`: `GuideProvider` (mounted by the
  shell) decides what to show, `GuideHelp` is the menu. The card is a
  non-modal dialog, labelled by the step's title and described by its text;
  starting a guide moves focus to it and ending one puts focus back. Colours
  come from the `c-*` theme tokens, and nothing animates when the system asks
  for reduced motion.
- **A new anchor** is a `data-guide="name"` attribute on the element and the
  name added to `ANCHORS` in `packages/spools/src/crm/guides.ts` (and to the table above).

## Limits

- Guides describe and point. They don't click, type, open menus or move
  between pages for you, so a step can only point at what is already on
  screen.
- A step's text is plain: no links, bold or line breaks.
- A person who dismisses a guide in one browser can be offered it once more in
  another browser that was already open, until that tab's session refreshes
  (within about a minute of the next page change).
- Beyond the order described under [Your own guides](#your-own-guides), an
  added guide can't be placed between two built-in ones.
- Offers appear at the bottom right, above a list's page footer. They can
  cover the last rows of a short window until answered.
