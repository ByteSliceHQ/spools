---
'@swirls/spools': minor
---

Many-to-many relations: a field can hold any number of records of another object.

- **`"type": "relations"`** in `crm.config.json`, with `to` (the target object) and an
  optional `inverse` (a `relations` field on that object that shows the same links from
  the other side): a contact has many tags, a person is on several teams. Each field that
  owns its links gets a table, `<object>_<field>`, with one row per pair. Run
  `bun run crm:gen` and `bun run db:push` after adding one. Nothing changes for a config
  without the field: it generates the schema it did before.
- **Reading.** A record brings back `<field>` (id and title of each related record),
  `<field>Ids` and `<field>Count`. Lists, boards and record pages show them as chips.
- **Writing.** `<field>Ids` takes a list of ids, which replaces the set, or
  `{ add, remove }`. It goes through `createRecord` and `updateRecord` like any field, in
  the same transaction, with a line on the timeline for what was added and removed. Forms
  and table cells use the relation picker with several records ticked.
- **Filters.** "Has any of", "has all of", "has none of", "is empty" and "is not empty"
  (`anyOf`, `allOf`, `noneOf`, `empty`, `notEmpty`) in the filter box, saved views, the
  config's view filters and the assistant's search.
- **CSV.** Export writes the related titles in one cell, separated by `;`, and import
  matches them by title.
- **For a database adapter:** a relation in a table description may now say
  `onDelete: 'cascade'`. An adapter that builds its own DDL from table descriptions needs
  to honour it; the three that ship do. No new condition was added to the store.
- **In your own code:** `fieldTypes[type].column` can be `null` (a `relations` field has
  no column), and a field type you render yourself needs a case for `relations`. An
  assistant workflow that describes how to write fields should mention `<field>Ids`: see
  `swirls/assistant.swirls` in a new Spool.
