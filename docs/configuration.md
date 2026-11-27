# Configuration reference

The CRM is defined by `crm.config.json` at the top of your app's folder. The full contract is
[`packages/spools/src/crm/config-schema.ts`](../packages/spools/src/crm/config-schema.ts); `crm.config.schema.json`
is generated from it so your editor can autocomplete and validate the file.

After any change:

```sh
bun run crm:gen   # validate the config, regenerate the Prisma schema and JSON Schema
bun run db:push   # with DATABASE_URL set: apply the schema to that database
```

`crm:gen` stops with a precise error (path and message) when the config is invalid.

## Top level

| Key                | Required | Description                                                                                                                                                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | yes      | Config format version. Currently `1`.                                                                                                                                                                               |
| `app.name`         | yes      | Your business name. Shown in the CRM, as "<name> CRM" in the browser tab, and on the sign-in and unsubscribe pages.                                                                                                 |
| `app.timezone`     | no       | Where the business keeps its calendar, as an IANA name such as `"America/New_York"` (default `"UTC"`). Decides when "today" and "this month" begin in [filters](search-and-filters.md#operators).                   |
| `access`           | yes      | Who may use the CRM. See [Access](#access).                                                                                                                                                                         |
| `objects`          | yes      | The record types. See [Objects](#objects).                                                                                                                                                                          |
| `files`            | no       | The shared library on the Files page: `{ "label": "Company files", "folders": ["Templates"] }`. The library exists without it. See [Files](files.md#the-library).                                                   |
| `automations`      | no       | Run something when records change. See [Automations](#automations).                                                                                                                                                 |
| `app.sendingHours` | no       | The hours a sequence's later emails may go out in, on the clock of `app.timezone`: `{ "from": "08:00", "to": "18:00" }`, weekdays only unless `"weekdaysOnly": false`. See [Campaigns](campaigns.md#sending-hours). |
| `campaigns`        | no       | Durable email sequences. See [Campaigns](#campaigns).                                                                                                                                                               |
| `guides`           | no       | Replace, turn off or add the short guides that show people around. See [Guides](guides.md#your-own-guides).                                                                                                         |
| `assistant`        | no       | How the Ask page presents the assistant. See [The assistant's page](#the-assistants-page).                                                                                                                          |

## Access

The CRM is deny-by-default. A user must be signed in **and** have a
verified primary email that matches the allowlist.

```json
"access": {
  "allowedDomains": ["acme.com"],
  "allowedEmails": ["contractor@gmail.com"]
}
```

At least one entry is required. With Clerk, restrict sign-ups there too (Clerk dashboard →
Restrictions) so strangers can't create accounts at all.

## Objects

Each key under `objects` is an object key (camelCase, used in URLs and the
database). `companies` becomes the `Company` model and the `companies` table.

```json
"contacts": {
  "label": "Contact",
  "labelPlural": "Contacts",
  "titleField": "name",
  "fields": { "name": { "type": "text", "required": true } },
  "views": [{ "id": "all", "label": "All contacts", "type": "table", "columns": ["name"] }],
  "actions": []
}
```

| Key                    | Required | Description                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label`, `labelPlural` | yes      | Display names.                                                                                                                                                                                                                                                                                         |
| `icon`                 | no       | Sidebar icon: `users`, `user`, `building`, `handshake`, `briefcase`, `calendar`, `checklist`, `clipboard`, `check`, `ticket`, `home`, `file`, `box`.                                                                                                                                                   |
| `titleField`           | yes      | Field used as the record's name everywhere.                                                                                                                                                                                                                                                            |
| `model`                | no       | Override the Prisma model name (default: PascalCase singular of the key).                                                                                                                                                                                                                              |
| `fields`               | yes      | See [Fields](#fields).                                                                                                                                                                                                                                                                                 |
| `views`                | yes      | At least one. See [Views](#views).                                                                                                                                                                                                                                                                     |
| `actions`              | no       | Buttons on the record page. See [Actions](#actions).                                                                                                                                                                                                                                                   |
| `files`                | no       | Give each of this object's records a folder in the file store and a Files tab. `{ "folders": ["Drawings", "Proposal"] }` names folders made inside each record's folder; `"under": "<relation field>"` nests a record's folder inside the related record's. See [Files](files.md#a-folder-per-record). |

Reserved object keys: `assistant`, `settings`, `new`, `tasks`, `notes`, `reports`, `workflows`, `integrations`, `files`, `api`, `crm`, `unsubscribe`. Every object also gets
system fields `id`, `createdAt`, `updatedAt` and `createdBy`, which you can use in
views but not redefine.

## Fields

Common options for every field:

| Key           | Description                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | One of the types below.                                                                                                                                         |
| `label`       | Display label (default: the key in Title Case).                                                                                                                 |
| `description` | Help text under the input.                                                                                                                                      |
| `required`    | Not-null column and a required input.                                                                                                                           |
| `searchable`  | Found by [search](search-and-filters.md#search): Cmd+K, the box on every list, and relation pickers. Text-like fields only. The title field is always searched. |
| `encrypted`   | Field-level encryption intent. See [Encryption](#encryption).                                                                                                   |

| Type                                        | Stored as              | Extra options                                                                                                                          |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `longtext`, `email`, `phone`, `url` | `text`                 | `default` (string)                                                                                                                     |
| `number`                                    | `double precision`     | `default` (number)                                                                                                                     |
| `currency`                                  | `numeric(14,2)`        | `currency` (ISO code, default `USD`), `default`                                                                                        |
| `boolean`                                   | `boolean`              | `default`                                                                                                                              |
| `date`                                      | `date`                 |                                                                                                                                        |
| `datetime`                                  | `timestamptz`          |                                                                                                                                        |
| `select`                                    | `text`                 | `options: [{ value, label?, color?, probability?, when? }]`, `default`, `dependsOn`. See [Pipelines and stages](#pipelines-and-stages) |
| `relation`                                  | `<key>_id` foreign key | `to`: target object key                                                                                                                |
| `relations`                                 | a links table          | `to`: target object key; `inverse`: a `relations` field on that object. See [Many related records](#many-related-records)              |
| `user`                                      | `text`                 | A person on your team (owner, assignee). Shown as a picker of everyone on the access allowlist; stores the auth provider's id for them |

Need a type that isn't here? [Add one](extending.md#add-a-field-type) in two files.

Colors: `gray`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `indigo`, `purple`, `pink`.

A `relation` is many-to-one: a deal has one company. Optional relations are
cleared when the target is deleted; required relations block the delete. When
writing a relation through the API or the assistant, pass `<field>Id` (for
example `companyId`). For many on both sides (a contact has several tags, a tag
is on several contacts) use [`relations`](#many-related-records).

In the app a relation is chosen by searching the related object, in forms, in a
table cell and in a filter. The search looks at the related object's title and
its `searchable` fields, so a contact can be found by email as well as by name.
Every word typed must be found in one of them. It works the same for ten records
or ten thousand.

Select values are stored as plain text, so adding options never needs a
migration. Removing an option leaves existing records with that value.

### Many related records

A `relations` field holds any number of records of another object, or of its
own:

```json
"contacts": {
  "fields": {
    "tags": { "type": "relations", "to": "tags" },
    "teams": { "type": "relations", "to": "teams" }
  }
},
"tags": {
  "fields": {
    "name": { "type": "text", "required": true },
    "contacts": { "type": "relations", "to": "contacts", "inverse": "tags" }
  }
}
```

`inverse` names a `relations` field on the target object that this field is
the other side of. Both then show and change the same links: add a tag to a
contact and the contact appears under that tag. Set `inverse` on one side
only. The side without it owns the links, so adding an inverse later moves
nothing. Without an inverse, the other object's record pages still list the
records that hold it.

In the app the field is shown as chips, in tables, on board cards and on the
record. It is edited with the same search as a `relation`, where any number of
records can be ticked. It can be [filtered](search-and-filters.md#operators),
and not sorted by.

A record brings its related records back under three keys:

| Key            | Holds                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| `<field>`      | The related records, each as `{ "id", "<its title field>" }`, in title order.             |
| `<field>Ids`   | Their ids, in the same order.                                                             |
| `<field>Count` | How many there are. A record brings back at most 100; the count says when there are more. |

Write the field as `<field>Ids`, through the API, the assistant, a hook or a
form:

| Value                                        | Does                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| `["<id>", "<id>"]`, or the ids in one string | Replaces the set. `[]` or `""` empties it.               |
| `{ "add": ["<id>"], "remove": ["<id>"] }`    | Links and lets go of those records, and leaves the rest. |

One write names at most 100 ids. An id that is not a record of the target
object is refused, and nothing of the change is kept. A list is refused when the
record holds more than the 100 a read brings back, because whoever sent it
cannot have seen what it would remove: use `add` and `remove` there. The app's
own forms and cells always send `add` and `remove`.

A change to a record's links is a change to that record: it goes through its
hooks and automations, moves its `updatedAt`, and adds a line to its timeline
("added Tags: VIP, Partner"). The records at the other end are not changed: no
hook runs for them and their timelines say nothing.

Each field that owns its links has a table, `<object>_<field>` (`contacts_tags`),
with one row per pair, made by `bun run crm:gen` and `bun run db:push` like any
other. Deleting a record deletes its links, never the records at the other end.
`crm:gen` refuses a target or an inverse that doesn't fit, `required`, a field
named `<field>Ids`, `<field>Count` or `<field>Links` beside it, a links table
whose name another table has, and a view sorted by the field. Renaming the
field or its object names a new, empty table: the links stay in the old one
until you move them.

### Pipelines and stages

A stage is a `select` field. Two option keys turn it into a sales pipeline:

- `probability` (0 to 100) is the chance of winning a record at that stage. When
  any option has one, boards show a weighted total beside each column's sum, and
  Reports adds a weighted total to the field's breakdown.
- `when` limits an option to some values of another select, named by the field's
  `dependsOn`. That gives one object several pipelines, each with its own stages.
  Options without `when` belong to every pipeline.

```json
"pipeline": {
  "type": "select",
  "default": "sales",
  "options": [{ "value": "sales", "label": "Sales" }, { "value": "bids", "label": "Bids" }]
},
"stage": {
  "type": "select",
  "dependsOn": "pipeline",
  "default": "proposal",
  "options": [
    { "value": "proposal", "label": "Proposal sent", "when": ["sales"], "probability": 40 },
    { "value": "bidOut", "label": "Bid out", "when": ["bids"], "probability": 50 },
    { "value": "won", "label": "Won", "probability": 100 },
    { "value": "lost", "label": "Lost", "probability": 0 }
  ]
}
```

Forms and pickers only offer the stages that apply, and the server rejects any
other value whoever sends it (the CRM, a CSV import, the assistant). Moving a
record to another pipeline moves it to that pipeline's first stage, unless its
stage belongs to both. A new record takes the stage's `default` if it applies to
the chosen pipeline, and the pipeline's first stage if not. `dependsOn` must name
a select on the same object that doesn't depend on a field itself.

Give each pipeline its own board with a [view filter](#views):

```json
{
  "id": "sales",
  "label": "Sales pipeline",
  "type": "board",
  "groupBy": "stage",
  "filters": { "pipeline": "sales" }
}
```

### Encryption

`"encrypted": "storage" | "eq" | "match" | "search"` marks a field for
[CipherStash](https://cipherstash.com) searchable encryption:

| Mode      | Queries on ciphertext            |
| --------- | -------------------------------- |
| `storage` | none (encrypted at rest only)    |
| `eq`      | exact match                      |
| `match`   | free-text search                 |
| `search`  | exact match, range and free-text |

The mode also decides what the app will ask of the field today: which
[filter operators](search-and-filters.md#encrypted-fields) it offers, and
whether search reads it. An encrypted field's values are never part of the
index the browser searches, apart from a record's title.

> **Status:** `@cipherstash/stack-prisma` doesn't support Prisma 8 yet, so marked
> fields are currently stored as **plaintext**. `crm:gen` prints a warning for each
> one. Keep the markers: once support lands, the generator will emit encrypted
> column types and no config change will be needed.

## Views

```json
{ "id": "all", "label": "All deals", "type": "table", "columns": ["title", "value", "stage"], "sort": { "field": "createdAt", "dir": "desc" } }
{ "id": "pipeline", "label": "Pipeline", "type": "board", "groupBy": "stage", "cardFields": ["value", "company"] }
```

- `table`: a spreadsheet. `columns` are field keys (including system columns:
  `createdAt`, `updatedAt`, `createdBy`, and the activity dates `lastActivityAt`,
  `lastContactedAt` and `nextTaskDue`), with an optional default `sort`: one
  `{ "field", "dir" }`, or a list of up to three. Cells edit in place; column
  headers sort and filter; rows can be selected and deleted in bulk. A relation
  sorts by the related record's title.
- `board`: a kanban grouped by a `select` field; each option becomes a column.
  Drag a card to another column to change the field. Columns show a count, and a
  total of the first `currency` field in `cardFields`.
- `filters` (either type) starts the view showing only the records that match.
  The short form pins fields to a value: `{ "pipeline": "sales" }` or
  `{ "active": true }`. The long form is a list of conditions with operators,
  such as `[{ "field": "value", "op": "gte", "value": 5000 }]`; every field type
  has its own operators, and conditions can reach through relations. See
  [Search and filters](search-and-filters.md#in-the-config). A board filtered to
  one value of the field its `groupBy` depends on only shows the columns that
  apply, and a record created from a filtered view starts out matching it.

The first view is the default; the rest are in the view menu (`?view=<id>`). Tables
show 50 records a page; boards show up to 500 cards. Every list can be searched,
filtered by any field and sorted by up to three columns: see
[Search and filters](search-and-filters.md).

### Views saved in the app

The views in the config are the starting point. In the CRM, anyone can change a
view's columns, sort, filters and footer calculations (sum, average, min, max,
filled, empty), or create a new view from the view menu. Those changes are stored in
the `saved_views` table and shared with everyone, so they need no deploy.

- Columns and calculations are saved as they are changed. Filters and sort are
  tried first: they go in the page address, so the list can be linked to, and
  are written to the view when someone presses Save. "Save as a new view" makes
  a view for everyone or one only its maker sees.

- Changing a config view stores an override. "Reset to default" in the view menu
  deletes it and the view goes back to what the config says.
- Views created in the app can be renamed and deleted there.
- If you later remove a field from the config, saved views drop it. A config change
  can't break a saved view.

## Built into every CRM

These need no configuration:

| Page      | What it does                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home      | Record counts, your open tasks, recent activity, and a box that asks the assistant                                                                                                                                                                                                                                    |
| Tasks     | To-dos with a due date and assignee, optionally linked to a record                                                                                                                                                                                                                                                    |
| Files     | A file browser over the whole drive: a folder per record, a shared library, and any folders the team adds. Needs a file store: see [Files](files.md)                                                                                                                                                                  |
| Notes     | Titled notes, optionally linked to a record                                                                                                                                                                                                                                                                           |
| Reports   | Team activity: calls, emails, meetings, completed tasks and notes per teammate for a period you pick, with CSV export. Records created per week, and a breakdown of every `select` field. If the object has a `currency` field, each breakdown also totals it, weighted by win probability when the options have one. |
| Workflows | Your automations, record actions and campaigns, with recent runs                                                                                                                                                                                                                                                      |
| Ask       | The assistant, laid out like the chat assistants people already use: past chats in the sidebar, a reply column, and a box at the bottom. Needs Swirls: see [The assistant](swirls.md#the-assistant)                                                                                                                   |

Every page also has a short [guide](guides.md), offered to each person once
and replayable from Help at the bottom of the sidebar.

Record pages add an activity timeline, favourites, and (for objects with an `email`
field) a button that sends a one-off email, from the teammate's [own mailbox](mailbox.md)
when their sign-in allows it and otherwise through your email provider. Calls and
meetings are logged from a record page with an outcome, when they took place and
notes.

### Team activity report

Reports opens with a table of what each teammate did in a period (today, this or
last week or month, the last 30 or 90 days, this year, or a custom range of up to
two years):

| Column          | Counts                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calls           | Calls logged on a record, with how many connected                                                                                                                |
| Emails          | Emails sent from a record page, and emails teammates sent to contacts from [their own mailbox](mailbox.md). Emails sent by sequences are listed under "Sequence" |
| Meetings        | Meetings logged on a record, and finished calendar events with contacts from a teammate's calendar                                                               |
| Tasks completed | Tasks completed in the period, credited to whoever completed them                                                                                                |
| Notes           | Notes written in the period                                                                                                                                      |

Everyone on the access allowlist is listed, including people with nothing logged.
A call or meeting counts on the day it took place, not the day it was entered.
"Export CSV" downloads the table for the chosen period. Email and meetings are
picked up automatically for teammates who have connected their account; calls
made on a phone are only counted once someone logs them.

Any view can be exported as CSV, and CSV files can be imported: columns are matched
to fields by key or label, `select` values by option label, and relations by the
related record's title. A `relations` field is one cell with its titles
separated by `;` (`VIP; Partner`), up to 1,000 of them on export; on import each
title is matched the same way, and one that matches nothing is left out. A title
that itself contains `;` can't be matched: use the record's id in its place. An
import is limited to 1,000 rows and doesn't fire automations.

## Actions

Buttons on the record page:

```json
{ "id": "enrich", "label": "Enrich with AI", "run": "swirls:enrich_contact" },
{ "id": "onboard", "label": "Start onboarding", "run": "campaign:onboarding", "confirm": "Send the onboarding sequence?" }
```

`run` targets (shared with automations):

| Target              | What runs                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `swirls:<workflow>` | A deployed Swirls workflow, by name. Input: `{ objectKey, record, actor, trigger }`. See [Swirls](swirls.md). |
| `campaign:<key>`    | Enrolls the record in a campaign (once per record).                                                           |
| `local:<handler>`   | A handler in [`src/app/extensions.ts`](../apps/starter/src/app/extensions.ts).                                |
| `<kind>:<name>`     | Any kind your extensions register. See [Extending](extending.md#run-targets-add-a-new-kind).                  |

`crm:gen` and server start-up check that every target resolves, so a misspelt
campaign, handler or kind fails early instead of when someone clicks the button.

## Automations

```json
"automations": [
  { "on": "contacts.created", "run": "swirls:new_contact" },
  { "on": "deals.updated", "run": "local:notifySlack" }
]
```

Events: `<objectKey>.created`, `.updated`, `.deleted`. They fire for changes made
in the CRM UI and the assistant. Failures are logged and
never block the change that triggered them. To change or reject a write, or to
compare against the previous value, use [hooks](extending.md#hooks-react-to-record-changes).

## Campaigns

```json
"campaigns": {
  "onboarding": {
    "label": "Onboarding",
    "object": "contacts",
    "emailField": "email",
    "stopWhen": { "status": ["customer", "churned"] },
    "steps": [
      { "id": "welcome", "wait": "0m", "subject": "Welcome, {{name}}", "body": "Hi {{name}}, ..." },
      { "id": "tips", "wait": "3d", "subject": "Three tips", "body": "..." }
    ]
  }
}
```

- `wait` is relative to the previous step: `"0m"`, `"90m"`, `"12h"`, `"3d"`.
- `{{field}}` placeholders are filled from the record when each step sends, so edits
  made mid-campaign are picked up. `{{unsubscribeUrl}}` is also available.
- Before every step the record is re-read. If it was deleted or a `stopWhen` field
  matches, the sequence stops for that record. If the address is missing or on the
  suppression list, that one email is skipped and the next is tried when it is due.

See [Campaigns](campaigns.md) for delivery, unsubscribes and operations.

## Marketing

```json
"marketing": {
  "website": "https://acme.com",
  "tags": { "ga4": "G-ABCDE12345", "metaPixel": "1234567890123456" },
  "channels": {
    "company": { "label": "LinkedIn page", "network": "linkedin", "account": "urn:li:organization:12345" }
  },
  "ads": {
    "meta": { "label": "Meta Ads", "network": "meta", "account": "1234567890" }
  }
}
```

- `website` is the business's site, as an `https://` address. It is the only required part.
- `tags` are the tracking tags the business uses, by id: `gtm`, `ga4`, `googleAds`,
  `metaPixel`, `linkedinInsight`. Each id must be in its vendor's form.
- `channels` are where posts can go. `network` is `linkedin`, `facebook`, `x`, or one your
  app adds.
- `ads` are the ad accounts whose results are shown. `network` is `meta`, `google`, or one
  your app adds.
- `via` on a channel or an ad account says who calls the network: `"direct"` (the CRM,
  the default where it can) or `"swirls"` (a workflow).

With this block the sidebar gains a Marketing page. `marketing` can no longer be used as
an object's key. See [Marketing](marketing.md).

## The assistant's page

`assistant` changes how the Ask page presents the assistant. What the assistant
can do is not set here: that is its tools, in `swirls/assistant.swirls` (see
[Swirls](swirls.md#the-assistant)).

```json
"assistant": {
  "name": "Assistant",
  "greeting": "What can I help with?",
  "suggestions": [
    { "label": "Open deals", "prompt": "Which deals are in negotiation, and what are they worth?" },
    { "label": "Overdue tasks", "prompt": "Which records have a task that is overdue?" }
  ]
}
```

| Key           | Description                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | What the assistant is called on the page: the box says "Ask <name>". Default `"Assistant"`, up to 40 characters.                                                                                                          |
| `greeting`    | The line a new chat opens with. Default `"What can I help with?"`.                                                                                                                                                        |
| `suggestions` | Up to six prompts offered under the box of a new chat. `label` is the button (up to 40 characters); `prompt` is what gets asked when it is pressed. Without any, the page writes four from the first object in `objects`. |
