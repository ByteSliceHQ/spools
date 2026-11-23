import type { PublicCrmConfig } from './config'
import { fieldLabel } from './naming'

/** CSV import helpers. Pure, so the import dialog and the tests share them. */

type Obj = PublicCrmConfig['objects'][string]
type RelationTitles = Record<string, { id: string; title: string }[]>

/** Parse CSV text (RFC 4180: quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++
      }

      row.push(cell)
      cell = ''

      if (row.some((c) => c !== '')) {
        rows.push(row)
      }

      row = []
    } else {
      cell += ch
    }
  }

  row.push(cell)

  if (row.some((c) => c !== '')) {
    rows.push(row)
  }

  return rows
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** How a relation cell is compared with a record's title: case, spaces and punctuation don't count. */
export const titleKey = norm

type Column = { key: string; field: Obj['fields'][string] } | null

/** Match a header row to the object's fields, by key or label. */
function matchColumns(obj: Obj, header: string[]): Column[] {
  return header.map((h) => {
    const wanted = norm(h)

    const match = Object.entries(obj.fields).find(
      ([key, field]) => norm(key) === wanted || norm(fieldLabel(key, field)) === wanted,
    )

    return match ? { key: match[0], field: match[1] } : null
  })
}

/**
 * What the relation columns of a CSV say, per related object, without repeats.
 * The server is asked which records these name (`matchRelationTitlesFn`), and
 * its answer is what `mapCsv` takes as `relationOptions`.
 */
export function relationCells(obj: Obj, table: string[][]): Record<string, string[]> {
  const [header = [], ...body] = table
  const cells = new Map<string, string[]>()

  matchColumns(obj, header).forEach((col, i) => {
    if (col?.field.type !== 'relation') {
      return
    }

    const said = body.map((row) => (row[i] ?? '').trim()).filter((raw) => raw !== '')
    cells.set(col.field.to, [...new Set([...(cells.get(col.field.to) ?? []), ...said])])
  })

  return Object.fromEntries(cells)
}

/**
 * Turn CSV rows into record values: columns are matched to fields by key or label,
 * select labels become option values, and relation titles become record ids.
 * `relationOptions` holds the records the relation cells may name.
 */
export function mapCsv(obj: Obj, relationOptions: RelationTitles, table: string[][]) {
  const [header = [], ...body] = table
  const columns = matchColumns(obj, header)

  const rows = body.map((cells) => {
    const values: Record<string, string> = {}

    columns.forEach((col, i) => {
      const raw = (cells[i] ?? '').trim()

      if (!col || raw === '') {
        return
      }

      if (col.field.type === 'select') {
        const option = col.field.options.find(
          (o) => norm(o.value) === norm(raw) || norm(o.label ?? '') === norm(raw),
        )

        values[col.key] = option?.value ?? raw
      } else if (col.field.type === 'relation') {
        const related = (relationOptions[col.field.to] ?? []).find(
          (o) => o.id === raw || norm(o.title) === norm(raw),
        )

        if (related) {
          values[`${col.key}Id`] = related.id
        }
      } else {
        values[col.key] = raw
      }
    })

    return values
  })

  return {
    rows: rows.filter((r) => Object.keys(r).length > 0),
    matched: columns.flatMap((c) => (c ? [fieldLabel(c.key, c.field)] : [])),
    ignored: header.filter((_, i) => !columns[i]),
  }
}
