# Search and filters

How people find things in the CRM, and how it is built. The first half is what
the app does; the second is for whoever changes it.

- [Search](#search)
- [Filters](#filters)
- [Sorting](#sorting)
- [Views and links](#views-and-links)
- [Keys](#keys)
- [In the config](#in-the-config)
- [How it works](#how-it-works)
- [Limits](#limits)

## Search

Cmd+K (Ctrl+K) opens search from any page. On a narrow screen it is the
magnifying glass in the top bar.

| It finds                   | By                                                                  |
| -------------------------- | ------------------------------------------------------------------- |
| Records of every object    | Their title and every [`searchable`](configuration.md#fields) field |
| Notes                      | Title and body                                                      |
| Emails, calls and meetings | Subject or summary, and body                                        |
| Tasks                      | Title                                                               |
| Files                      | File and folder names (when a [file store](files.md) is set up)     |
| Pages, views and "New …"   | Name                                                                |

With nothing typed it lists the records you opened most recently (kept in the
browser you are using) and your favourites.

**Order.** Records come first, best match first: the whole title, a title that
starts with what you typed, a word in the title that starts with it, a title
that contains it, another field that contains it, then near-misses. A near-miss
is one wrong, missing, extra or swapped letter in a word of four letters or
more, so `acem` finds "Acme". Ties go to what you opened recently, then to
what changed most recently. Every word you type must match somewhere. Accents
and capitals are ignored. Digits typed like a phone number match however the
number was stored: `4105550101` finds "(410) 555-0101".

**Groups.** "Best matches" (when more than one kind of record matches), one
group per object, then Notes, Emails and calls, Tasks and Files. A group shows
five results and a "Show all" row that opens the object's list with the search
applied. Each record shows a second line that tells it from others of the same
name (the first short columns of the object's table view) or, when the match
was not in the title, the field and text that matched.

Notes, emails, calls, tasks and files appear a moment after you stop typing,
under what is already shown. In their text, word endings don't matter
("cabinets" finds "cabinet") and the last word may be unfinished.

Tab narrows the search to one object: the one whose name you typed, or the one
the highlighted result belongs to.

## Filters

Every list has one box for searching and filtering. Typing narrows the list as
you go. When what you type can be read as a filter, the box offers it:

| Type                                                                   | It offers                              |
| ---------------------------------------------------------------------- | -------------------------------------- |
| `won`                                                                  | Stage is Won                           |
| `dana`                                                                 | Owner is Dana                          |
| `chicago`                                                              | City is Chicago, with how many records |
| `smith`                                                                | Contact is John Smith                  |
| `>5000`, `over 5k`, `5000-10000`                                       | Value > 5,000 and so on                |
| `this month`, `last 30 days`, `over 30 days ago`                       | on each date field                     |
| `no email`, `has owner`, `no deals`                                    | Email is empty, and so on              |
| `stage won`, `close date next week`, `last contacted over 30 days ago` | the named field with that value        |
| `city`                                                                 | Filter by City… (opens its editor)     |

Tab takes the first offer, or the highlighted one. When the text can only be a
filter (`>5000`, `no email`, an option's whole name) the offer is highlighted
already and Enter takes it. The **Filter** button, or `F`, lists every field. A
column's heading offers "Filter by this column". Click a filter to change its
operator or value, and its × to remove it.

### Operators

| Field type                                  | Operators                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `text`, `longtext`, `email`, `phone`, `url` | contains, does not contain, is, is not, starts with, ends with, is empty, is not empty                                    |
| `number`, `currency`                        | =, ≠, >, ≥, <, ≤, is between, is empty, is not empty                                                                      |
| `date`, `datetime`, Created, Updated        | is, is before, is after, is between, in the last N days, in the next N days, more than N days ago, is empty, is not empty |
| `select`, `relation`, `user`, Created by    | is any of, is none of, is empty, is not empty                                                                             |
| `boolean`                                   | is yes, is no                                                                                                             |

"Is", "is before" and "is after" take a date or a period: today, yesterday,
tomorrow, or this, last or next week, month, quarter or year. A period is kept
as written and worked out each time the list loads, in the time zone set by
[`app.timezone`](configuration.md#top-level), so a view of "closing this month"
is always this month. Weeks start on Monday.

Text is matched whatever its case. "Is not", "does not contain" and "is none
of" include records where the field is empty. For a teammate field, **Me**
stands for whoever is looking, so one shared "My deals" view works for
everyone.

### Activity

Every object has three dates the CRM keeps for you. They filter, sort and show
as columns like any date field.

| Field          | What it is                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------- |
| Last activity  | The most recent call, meeting, email, note or task on the record                             |
| Last contacted | The most recent call, meeting or email. An email that was drafted but not sent doesn't count |
| Next task due  | The earliest due date among the record's open tasks                                          |

"Not contacted in 30 days" is _Last contacted more than 30 days ago_; "never
contacted" is _Last contacted is empty_; "no next step" is _Next task due is
empty_. Field edits and automations don't count as activity.

### Through relations

- **A field of a related record.** Open a relation under "Fields of related
  records" in the Filter list, or type both names ("company ind"): _Company ›
  Industry is Finance_ shows deals whose company is in finance. A deal with no
  company is treated as a deal whose company has nothing in that field: it
  matches "is empty", "is not", "is none of" and "does not contain", and
  nothing else.
- **Records that point here.** Under "Related records": _has any deals_, _has
  no deals_, optionally only those where some condition holds (_has deals where
  Stage is Won_).

Both go one step: not the company's owner's team, and not a condition through
a relation inside "has deals where".

A list takes up to 4 sets of filters, 10 filters in a set, 5 conditions inside
one "has … where", and 40 conditions in all. Past that the Filter button is
disabled, and a link that carries more is cut back to that many.

### Combining

Filters side by side must all hold. One filter can hold several values (_Stage
is Won or Lost_). **or** starts a second set: a record is shown when it meets
every filter of either set.

### Encrypted fields

A field marked [`encrypted`](configuration.md#encryption) can only be asked what
its mode will be able to answer once encryption is in force:

| Mode      | Filters                                            | Search |
| --------- | -------------------------------------------------- | ------ |
| `storage` | is empty, is not empty                             | no     |
| `eq`      | those, and is, is not                              | no     |
| `match`   | is empty, is not empty, contains, does not contain | yes    |
| `search`  | all                                                | yes    |

The values the filter box offers as you type ("City is Chicago") come only
from unencrypted fields and ones marked `search`.

## Sorting

The Sort control, or a column's heading, sorts by any column, including a
relation (by the related record's title) and the activity dates. Up to three
levels: "Then sort by this" adds one. Empty values go last in either direction.

## Views and links

Filters and sort you change are tried, not saved: they go in the page address.
So a filtered list can be bookmarked or sent to a colleague, Back undoes the
last change, and nobody else's view changes under them. When what is on screen
differs from the saved view:

- **Save** writes it to the view, for everyone who uses it.
- **Save as a new view** makes a view for everyone, or one only you see.
- **Reset** goes back to the view as saved.

Columns, board cards and footer calculations are still saved as you change
them. CSV export, footer calculations and boards all follow the filters on
screen, and a record created from a filtered list starts out matching it when
the filters pin a field to one value.

## Keys

| Key                       | Where              | Does                                |
| ------------------------- | ------------------ | ----------------------------------- |
| Cmd+K / Ctrl+K            | anywhere           | Open search                         |
| ↑ ↓, Enter                | search, filter box | Move, choose                        |
| Cmd+Enter                 | search             | Open in a new tab                   |
| Tab                       | search             | Narrow to one object                |
| Backspace in an empty box | search             | Search everything again             |
| `/`                       | a list             | Put the caret in the filter box     |
| `F`                       | a list             | List the fields to filter by        |
| Tab                       | filter box         | Take the first or highlighted offer |
| Backspace in an empty box | filter box         | Remove the last filter              |
| Esc                       | either             | Close the list, then clear the box  |

## In the config

Mark the fields people will look things up by as `searchable`: phone numbers,
addresses, reference numbers.

Set the business's time zone once:

```json
"app": { "name": "Acme", "timezone": "America/New_York" }
```

A view's `filters` is where the view starts. The short form pins fields to one
value; the long form is a list of conditions, all of which must hold; a list of
lists matches when any one list does.

```json
"filters": { "pipeline": "sales" }

"filters": [
  { "field": "stage", "op": "notIn", "value": ["won", "lost"] },
  { "field": "value", "op": "gte", "value": 5000 },
  { "field": "lastContactedAt", "op": "olderThan", "value": 30 },
  { "field": "company.industry", "op": "in", "value": ["finance"] },
  { "field": "owner", "op": "in", "value": ["@me"] }
]
```

| `op`                                                               | Field types                      | `value`                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `contains`, `notContains`, `is`, `isNot`, `startsWith`, `endsWith` | text-like                        | a string                                                                                                                                      |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte`                              | number, currency                 | a number                                                                                                                                      |
| `between`                                                          | number, currency, date, datetime | `[low, high]`                                                                                                                                 |
| `on`, `before`, `after`                                            | date, datetime                   | `"YYYY-MM-DD"` or a period: `today`, `yesterday`, `tomorrow`, `thisWeek`, `lastWeek`, `nextWeek`, and the same for `Month`, `Quarter`, `Year` |
| `inLast`, `inNext`, `olderThan`                                    | date, datetime                   | a number of days                                                                                                                              |
| `in`, `notIn`                                                      | select, relation, user           | a list of option values, record ids or user ids (`"@me"` for the viewer)                                                                      |
| `yes`, `no`                                                        | boolean                          | none                                                                                                                                          |
| `empty`, `notEmpty`                                                | any                              | none                                                                                                                                          |
| `has`, `hasNone`                                                   | `~object.field`                  | none; optional `where`: conditions on those records                                                                                           |

`field` is a field key, a system column (`createdAt`, `updatedAt`, `createdBy`,
`lastActivityAt`, `lastContactedAt`, `nextTaskDue`), `relation.field` for a
field of a related record, or `~object.field` for the records of `object` whose
relation `field` points here. `crm:gen` rejects a condition the app would not
apply.

`sort` takes one `{ "field", "dir" }` or a list of up to three.

The [assistant's](swirls.md) `crm_search` tool takes the same conditions as
`filters`.

## How it works

| Piece                                                                   | Where                                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| What a condition is, operators per field type, relative dates, cleaning | `packages/spools/src/crm/filters.ts` (pure, shared)                                                                                |
| Conditions to a database query                                          | `packages/spools/src/server/filter-query.ts`, used by `listRecords` and `countMatching` in `packages/spools/src/server/records.ts` |
| Typed text to offered filters                                           | `packages/spools/src/crm/suggest.ts` (pure)                                                                                        |
| Matching and ranking in the browser, the index store                    | `packages/spools/src/crm/search.ts` (pure)                                                                                         |
| Building the index, searching text on the server, value suggestions     | `packages/spools/src/server/search.ts`                                                                                             |
| The search palette                                                      | `packages/spools/src/crm/ui/search.tsx`                                                                                            |
| The filter box, chips, editors and field list                           | `packages/spools/src/crm/ui/filter-bar.tsx`                                                                                        |
| Filters and sort in the page address, Save and Reset                    | `src/routes/_crm/$object/index.tsx`                                                                                                |
| Views as stored                                                         | `packages/spools/src/server/views.ts`                                                                                              |
| The activity dates                                                      | `refreshStats` in `packages/spools/src/server/records.ts`                                                                          |

**Search needs no request for records.** After the first page has loaded, the
browser fetches every record's id, title, summary line and its short,
unencrypted `searchable` fields once (`searchIndexFn`), and keeps them in memory for the
life of the tab; nothing is written to disk. Each key press is matched against
that. Before the index is used again after 30 seconds, or after a change made
in the tab, the browser asks only for what changed since (`updatedAt`), and
fetches everything again if the counts show something was deleted. Fields
marked `encrypted` are never in the index, apart from the title, and nor are
`longtext` fields; the server searches those. An object with more than 25,000 records has its 25,000 most
recently changed in the index, and the server finds the rest.

**The server searches text.** `searchDeepFn` runs a quarter of a second after
typing pauses, and a request still on its way when more is typed is abandoned:
records by every searchable field (which also covers what the index leaves
out), notes and activities through two Postgres full-text indexes
(`notes_search`, `activities_search`, declared in `packages/spools/src/crm/codegen.ts`), tasks
by title. Notes and activities come back newest first, with matches in the
title or subject ahead of matches in the body; they are not ranked by
relevance, because scoring every email that mentions a common word is slow.
File names are a separate request to the file store.

**Filters are data, checked in one place.** Whatever arrives from a page
address, a saved view, the config or the assistant goes through `cleanFilters`,
which keeps only conditions that name something the config has, with an
operator the field's type and encryption mode allow and a value of the right
shape. The rest is dropped (the assistant's tool reports it instead). The
query builder then only ever sees conditions it can express.

**The activity dates are columns** (`last_activity_at`, `last_contacted_at`,
`next_task_due`) on every object's table. `refreshStats` recomputes a record's
three from its activities and tasks whenever one is written; it does not touch
`updated_at`. To fill them for records that existed before, run it once per
object without a record id (see [Upgrading](upgrading.md)).

## Limits

- Tables show 50 records a page and boards up to 500 cards.
- Relations are followed one step, in either direction.
- A filter is limited in size (see [Through relations](#through-relations)),
  because every condition is a test on every record and a filter fits in a
  link. The limits are in `packages/spools/src/crm/filters.ts`. They bound what one request can
  ask; they are not a substitute for a statement timeout on the database role.
- No roll-up filters ("more than three deals") and no saved lists of records
  apart from views.
- File search covers names, not contents.
- Recently opened records are remembered per browser, not per person.
- Without database indexes on text columns, "contains" reads every row of the
  object. That takes a few milliseconds for thousands of records. Past a few
  hundred thousand, add trigram indexes (`pg_trgm`) on the searchable columns.
