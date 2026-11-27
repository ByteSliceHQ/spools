import { Effect } from 'effect'
import { z } from 'zod'

import { cleanFilters, cleanSort, type Filters, type Sort, SYSTEM_COLUMNS } from '../crm/filters'
import { countMatching, listRecords } from './records'
import { NotFound } from './runtime/errors'
import { crmConfig, getObject } from './spool'
import { asc } from './store/query'
import { Store } from './store/store'
import { SavedView } from './store/tables'

/**
 * Views: how a list of records is shown. Views declared in crm.config.json are the
 * starting point; anything a user changes in the app (columns, sort, filters,
 * calculations) or creates from scratch is stored in the `saved_views` table.
 */

export type { Sort }
export type Calculation = 'sum' | 'avg' | 'min' | 'max' | 'filled' | 'empty'

export type ViewSettings = {
  columns: string[]
  /** Up to three levels; empty means newest first. */
  sort: Sort[]
  /** Groups of conditions (src/crm/filters.ts): a record matches every condition of any one group. */
  filters: Filters
  /** Board views: the select field whose options are the columns. */
  groupBy?: string
  cardFields: string[]
  calculations: Record<string, Calculation>
  /** A view only the person who made it sees. */
  private?: boolean
}

/** A change to a view: any of its settings, and its name. */
export type ViewPatch = Partial<ViewSettings> & { label?: string }

/** A view's settings as stored or declared: older ones hold one sort and a map of exact values to filter by. */
type RawSettings = Partial<Omit<ViewSettings, 'sort' | 'filters'>> & {
  sort?: unknown
  filters?: unknown
}

/**
 * Stored settings as JSON holds them. A setting that isn't what it should be is
 * dropped on its own, so the rest of the view survives; `sanitise` then checks
 * what is left against the config.
 */
const storedSettings: z.ZodType<RawSettings> = z.object({
  columns: z.array(z.string()).optional().catch(undefined),
  sort: z.unknown().optional(),
  filters: z.unknown().optional(),
  groupBy: z.string().optional().catch(undefined),
  cardFields: z.array(z.string()).optional().catch(undefined),
  calculations: z
    .record(z.string(), z.enum(['sum', 'avg', 'min', 'max', 'filled', 'empty']))
    .optional()
    .catch(undefined),
  private: z.boolean().optional().catch(undefined),
})

export type ResolvedView = {
  /** A config view id, or the saved view's uuid. */
  id: string
  label: string
  type: 'table' | 'board'
  /** `config` views can be customised and reset but not deleted. */
  source: 'config' | 'saved'
  customised: boolean
  settings: ViewSettings
}

/** Drop anything that no longer matches the config, so a config change can't break a saved view. */
export function sanitise(
  objectKey: string,
  raw: RawSettings,
  type: 'table' | 'board',
): ViewSettings {
  const obj = getObject(objectKey)
  const isField = (k: string) => Object.hasOwn(obj.fields, k)
  const isColumn = (k: string) => isField(k) || Object.hasOwn(SYSTEM_COLUMNS, k)
  const selects = Object.keys(obj.fields).filter((k) => obj.fields[k]?.type === 'select')

  const columns = (raw.columns ?? []).filter(isColumn)
  const sort = cleanSort(crmConfig().objects, objectKey, raw.sort)
  const filters = cleanFilters(crmConfig().objects, objectKey, raw.filters)
  const groupBy = raw.groupBy && selects.includes(raw.groupBy) ? raw.groupBy : selects[0]
  return {
    columns:
      columns.length > 0
        ? columns
        : [
            obj.titleField,
            ...Object.keys(obj.fields)
              .filter((k) => k !== obj.titleField)
              .slice(0, 4),
          ],
    sort,
    filters,
    groupBy: type === 'board' ? groupBy : undefined,
    cardFields: (raw.cardFields ?? []).filter(isField),
    calculations: Object.fromEntries(
      Object.entries(raw.calculations ?? {}).filter(([k]) => isColumn(k)),
    ),
    private: raw.private ? true : undefined,
  }
}

const parse = (json: string): RawSettings => {
  try {
    return storedSettings.safeParse(JSON.parse(json)).data ?? {}
  } catch {
    return {}
  }
}

/** The object's views. With `userId`, other people's private views are left out. */
export const resolveViews = Effect.fn('views.resolveViews')(function* (
  objectKey: string,
  userId?: string,
) {
  const obj = getObject(objectKey)
  const store = yield* Store
  const saved = yield* store.find(SavedView, { where: { objectKey }, order: [asc('createdAt')] })
  const overrides = new Map(saved.flatMap((s) => (s.key ? [[s.key, s] as const] : [])))

  const fromConfig: ResolvedView[] = obj.views.map((v) => {
    const base: RawSettings =
      v.type === 'table'
        ? { columns: v.columns, sort: v.sort, filters: v.filters }
        : { groupBy: v.groupBy, cardFields: v.cardFields, filters: v.filters }

    const override = overrides.get(v.id)
    return {
      id: v.id,
      label: override?.label ?? v.label,
      type: v.type,
      source: 'config',
      customised: !!override,
      settings: sanitise(
        objectKey,
        override ? { ...base, ...parse(override.settings) } : base,
        v.type,
      ),
    }
  })

  const custom: ResolvedView[] = saved
    .filter((s) => !s.key)
    .map((s) => {
      const type: ResolvedView['type'] = s.type === 'board' ? 'board' : 'table'
      return {
        id: s.id,
        label: s.label,
        type,
        source: 'saved' as const,
        customised: true,
        settings: sanitise(objectKey, parse(s.settings), type),
        createdBy: s.createdBy,
      }
    })
    .filter((v) => !v.settings.private || userId === undefined || v.createdBy === userId)
    .map(({ createdBy: _createdBy, ...view }) => view)

  const views: ResolvedView[] = [...fromConfig, ...custom]
  return views
})

/** Merge a change into a view and persist it. Config views get an override row. */
export const saveView = Effect.fn('views.saveView')(function* (
  objectKey: string,
  viewId: string,
  patch: ViewPatch,
  userId: string,
) {
  const view = yield* resolveViews(objectKey, userId).pipe(
    Effect.map((views) => views.find((v) => v.id === viewId)),
    Effect.filterOrFail(
      (found) => found !== undefined,
      () => new NotFound({ what: 'View' }),
    ),
  )

  const { label, ...settingsPatch } = patch

  const settings = JSON.stringify(
    sanitise(objectKey, { ...view.settings, ...settingsPatch }, view.type),
  )

  // A patch without a name keeps the one the view has.
  const changes = label ? { settings, label } : { settings }
  const store = yield* Store

  if (view.source === 'saved') {
    yield* store.update(SavedView, { where: { id: viewId } }, changes)
  } else {
    // A config view's change is kept in an override row.
    const existing = yield* store.first(SavedView, { where: { objectKey, key: viewId } })

    if (existing) {
      yield* store.update(SavedView, { where: { id: existing.id } }, changes)
    } else {
      yield* store.insert(SavedView, {
        objectKey,
        key: viewId,
        label: label ?? view.label,
        type: view.type,
        settings,
        createdBy: userId,
      })
    }
  }
})

export const createView = Effect.fn('views.createView')(function* (
  objectKey: string,
  input: {
    label: string
    type: 'table' | 'board'
    copyFrom?: string
    /** Laid over the copied view: the filters and sort on screen when "Save as new view" was chosen. */
    settings?: Partial<Pick<ViewSettings, 'filters' | 'sort'>>
    private?: boolean
  },
  userId: string,
) {
  const source = input.copyFrom
    ? (yield* resolveViews(objectKey, userId)).find((v) => v.id === input.copyFrom)
    : undefined

  const settings = JSON.stringify(
    sanitise(
      objectKey,
      { ...source?.settings, ...input.settings, private: input.private },
      input.type,
    ),
  )

  const store = yield* Store

  const row = yield* store.insert(SavedView, {
    objectKey,
    key: null,
    label: input.label,
    type: input.type,
    settings,
    createdBy: userId,
  })

  return row.id
})

/** Delete a saved view, or reset a customised config view to what the config says. */
export const deleteView = Effect.fn('views.deleteView')(function* (
  objectKey: string,
  viewId: string,
  userId: string,
) {
  const store = yield* Store

  const saved = yield* store.first(SavedView, { where: { id: viewId, objectKey } }).pipe(
    // Someone else's private view can't be seen or changed; it can't be deleted either.
    Effect.filterOrFail(
      (row) => !row || !parse(row.settings).private || row.createdBy === userId,
      () => new NotFound({ what: 'View' }),
    ),
  )

  // A saved view goes; a config view loses its override row, which puts it back as the config says.
  yield* store.remove(SavedView, { where: saved ? { id: viewId } : { objectKey, key: viewId } })
})

/**
 * The filters and sort a list is shown with: the ones its page address carries
 * when it carries any, else the view's own. An empty list in the address means
 * "none", which is different from not saying: clearing a view's last filter
 * must show everything, not put the saved filters back.
 */
export function activeSettings(
  objectKey: string,
  view: ResolvedView,
  asked: { filters?: unknown; sort?: unknown },
): Pick<ViewSettings, 'filters' | 'sort'> {
  return {
    filters:
      asked.filters === undefined
        ? view.settings.filters
        : cleanFilters(crmConfig().objects, objectKey, asked.filters),
    sort:
      asked.sort === undefined
        ? view.settings.sort
        : cleanSort(crmConfig().objects, objectKey, asked.sort),
  }
}

const CALCULATION_ROW_LIMIT = 5000

/** Footer calculations over every record the view matches (up to 5,000). */
export const calculate = Effect.fn('views.calculate')(function* (
  objectKey: string,
  filter: { q?: string; filters?: Filters; viewerId?: string },
  calculations: Record<string, Calculation>,
) {
  const columns = Object.keys(calculations)
  const out: Record<string, number | null> = {}

  if (columns.length === 0) {
    return out
  }

  const total = yield* countMatching({ objectKey, ...filter })
  const rows = []

  for (let offset = 0; offset < Math.min(total, CALCULATION_ROW_LIMIT); offset += 500) {
    rows.push(
      ...(yield* listRecords({ objectKey, ...filter, limit: 500, offset, relations: 'titles' })),
    )
  }

  for (const column of columns) {
    const values = rows.map((r) => r[column])

    // A relations field that holds nothing is an empty list.
    const present = values.filter(
      (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
    )

    const numbers = present.map(Number).filter((n) => Number.isFinite(n))
    const kind = calculations[column]

    if (kind === 'filled') {
      out[column] = present.length
    } else if (kind === 'empty') {
      out[column] = values.length - present.length
    } else if (numbers.length === 0) {
      out[column] = null
    } else if (kind === 'sum') {
      out[column] = numbers.reduce((a, b) => a + b, 0)
    } else if (kind === 'avg') {
      out[column] = numbers.reduce((a, b) => a + b, 0) / numbers.length
    } else if (kind === 'min') {
      out[column] = Math.min(...numbers)
    } else {
      out[column] = Math.max(...numbers)
    }
  }

  return out
})
