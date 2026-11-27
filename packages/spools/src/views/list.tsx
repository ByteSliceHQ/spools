import { getRouteApi, useRouter } from '@tanstack/react-router'
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Copy,
  Download,
  Kanban,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react'

import {
  type Filters,
  fieldOf,
  MAX_SORTS,
  pinnedValues,
  type Sort,
  SYSTEM_COLUMNS,
  sameJson,
} from '../crm/filters'
import { inputName } from '../crm/ui/fields'
import { FilterBar, type FilterBarHandle } from '../crm/ui/filter-bar'
import { fieldTypeIcons, ObjectIcon } from '../crm/ui/icons'
import { ImportDialog } from '../crm/ui/import-dialog'
import { Button, MenuDivider, MenuItem, MenuLabel, Popover } from '../crm/ui/kit'
import { NewRecordDialog } from '../crm/ui/new-record-dialog'
import { objectIndex, TopBar } from '../crm/ui/shell'
import { useCrmObject } from '../crm/ui/use-crm'
import { columnLabel, RecordView } from '../crm/ui/views'
import { deleteRecordsFn } from '../server/crm.functions'
import type { ResolvedView, ViewSettings } from '../server/views'
import { createViewFn, deleteViewFn, exportCsvFn, saveViewFn } from '../server/workspace.functions'

const route = getRouteApi('/_crm/$object/')

/** Values a new record starts out with, in the shape the new-record dialog takes them. */
type Preset = ComponentProps<typeof NewRecordDialog>['preset']

export function ObjectList(): ReactNode {
  const { object } = route.useParams()
  const { q, page = 1, new: openNew, f, s } = route.useSearch()
  // `titles` names the related records the filters point at; pickers search for the rest as they are used.
  const { views, view, active, rows, total, hasMore, calculations, titles } = route.useLoaderData()
  const { config, obj, titleFieldOf } = useCrmObject(object)
  const navigate = route.useNavigate()
  const router = useRouter()
  const bar = useRef<FilterBarHandle>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<{ preset?: Preset } | null>(null)
  const [importing, setImporting] = useState(false)
  const [menu, setMenu] = useState<'io' | 'save' | null>(null)

  // What is on screen differs from the saved view until someone saves it.
  const filters = active.filters
  const sort = active.sort
  const changed = !sameJson(filters, view.settings.filters) || !sameJson(sort, view.settings.sort)
  const shown = { ...view, settings: { ...view.settings, filters, sort } }

  const setFilters = (next: Filters) =>
    navigate({
      search: (prev) => ({
        ...prev,
        f: sameJson(next, view.settings.filters) ? undefined : next,
        page: undefined,
      }),
    })

  const setSort = (next: Sort[]) =>
    navigate({
      search: (prev) => ({
        ...prev,
        s: sameJson(next, view.settings.sort) ? undefined : next,
        page: undefined,
      }),
    })

  const reset = () =>
    navigate({ search: (prev) => ({ ...prev, f: undefined, s: undefined, page: undefined }) })

  /** Columns, card fields and calculations are saved at once; filters and sort wait for "Save". */
  const changeView = async (patch: ViewPatch) => {
    const { filters: nextFilters, sort: nextSort, ...layout } = patch

    if (nextFilters) {
      await setFilters(nextFilters)
    }

    if (nextSort) {
      await setSort(nextSort)
    }

    if (Object.keys(layout).length === 0) {
      return
    }

    await saveViewFn({ data: { objectKey: object, viewId: view.id, patch: layout } })
    await router.invalidate()
  }

  async function saveChanges() {
    setMenu(null)
    await saveViewFn({ data: { objectKey: object, viewId: view.id, patch: { filters, sort } } })
    await reset()
    await router.invalidate()
  }

  async function saveAsNew(onlyMe: boolean) {
    setMenu(null)
    const label = window.prompt('Name this view', `${view.label} copy`)

    if (!label?.trim()) {
      return
    }

    const { id } = await createViewFn({
      data: {
        objectKey: object,
        label: label.trim(),
        type: view.type,
        copyFrom: view.id,
        filters,
        sort,
        private: onlyMe,
      },
    })

    await router.invalidate()
    await navigate({ search: { view: id, q } })
  }

  async function deleteSelected() {
    const count = selected.size
    const noun = count === 1 ? obj.label.toLowerCase() : obj.labelPlural.toLowerCase()

    if (!window.confirm(`Delete ${count} ${noun}? This can't be undone.`)) {
      return
    }

    await deleteRecordsFn({ data: { objectKey: object, ids: [...selected] } })
    setSelected(new Set())
    await router.invalidate()
  }

  async function exportCsv() {
    setMenu(null)

    const { csv } = await exportCsvFn({
      data: { objectKey: object, viewId: view.id, q, filters: f, sort: s },
    })

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${object}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Remember this page of results so the record page can step through it.
  const rememberList = () => {
    try {
      window.sessionStorage.setItem(
        'crm-list',
        JSON.stringify({
          objectKey: object,
          label: view.label,
          total,
          ids: rows.map((r) => r.id),
          search: { view: view.id, q, page, f, s },
        }),
      )
    } catch {
      // Private browsing can block storage; previous/next just won't be offered.
    }
  }

  // "/" puts the caret in the filter box and "f" opens the list of fields, unless something is being typed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null
      const typing = el?.closest('input, textarea, select, [contenteditable=true], dialog[open]')

      if (typing || e.metaKey || e.ctrlKey || e.altKey) {
        return
      }

      if (e.key === '/') {
        e.preventDefault()
        bar.current?.focus()
      } else if (e.key === 'f') {
        e.preventDefault()
        bar.current?.pickField()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const filtered = filters.length > 0 || !!q

  return (
    <>
      <TopBar
        icon={<ObjectIcon icon={obj.icon} index={objectIndex(config, object)} />}
        title={obj.labelPlural}
      />

      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 px-3 py-1.5">
        <ViewMenu object={object} views={views} view={view} onChanged={() => router.invalidate()} />
        <ViewSettingsMenu obj={obj} view={view} onChange={changeView} />
        {changed && (
          <div className="relative flex items-center gap-1" data-guide="save-view">
            <Button
              variant="primary"
              onClick={saveChanges}
              title="Save these filters and this sort to the view, for everyone who uses it"
            >
              <Save className="size-3.5" /> Save
            </Button>
            <Button
              onClick={() => setMenu(menu === 'save' ? null : 'save')}
              aria-label="More ways to save"
            >
              <ChevronDown className="text-c-fg3 size-3" />
            </Button>
            <Button variant="ghost" onClick={reset}>
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            <Popover open={menu === 'save'} onClose={() => setMenu(null)} className="w-64">
              <MenuItem onSelect={saveChanges}>
                <Save className="text-c-fg2 size-3.5" /> Save to “{view.label}”
              </MenuItem>
              <MenuItem onSelect={() => saveAsNew(false)}>
                <Copy className="text-c-fg2 size-3.5" /> Save as a new view for everyone
              </MenuItem>
              <MenuItem onSelect={() => saveAsNew(true)}>
                <Lock className="text-c-fg2 size-3.5" /> Save as a new view only I see
              </MenuItem>
            </Popover>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative" data-guide="import-export">
            <Button onClick={() => setMenu(menu === 'io' ? null : 'io')}>
              <ArrowUpDown className="text-c-fg2 size-3.5" />{' '}
              <span className="hidden sm:inline">Import / Export</span>{' '}
              <ChevronDown className="text-c-fg3 size-3" />
            </Button>
            <Popover open={menu === 'io'} onClose={() => setMenu(null)} align="right">
              <MenuItem
                onSelect={() => {
                  setMenu(null)
                  setImporting(true)
                }}
              >
                <Upload className="text-c-fg2 size-3.5" /> Import CSV
              </MenuItem>
              <MenuItem onSelect={exportCsv}>
                <Download className="text-c-fg2 size-3.5" /> Export what is shown as CSV
              </MenuItem>
            </Popover>
          </div>
          <Button variant="primary" data-guide="new-record" onClick={() => setCreating({})}>
            <Plus className="size-3.5" /> New {obj.label}
          </Button>
        </div>
      </div>

      <FilterBar
        // A different list or view starts with an empty box.
        key={`${object}:${view.id}`}
        ref={bar}
        objectKey={object}
        filters={filters}
        onFilters={setFilters}
        q={q}
        onQuery={(value) =>
          navigate({
            search: (prev) => ({ ...prev, q: value || undefined, page: undefined }),
            replace: true,
          })
        }
        titles={titles}
        leading={<SortChip obj={obj} sort={sort} onChange={setSort} />}
        trailing={
          <span className="text-c-fg3 shrink-0 text-xs tabular-nums" aria-live="polite">
            {total.toLocaleString()}{' '}
            {total === 1 ? obj.label.toLowerCase() : obj.labelPlural.toLowerCase()}
          </span>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <RecordView
          object={object}
          obj={obj}
          view={shown}
          rows={rows}
          total={total}
          calculations={calculations}
          query={q}
          filtered={filtered}
          titleFieldOf={titleFieldOf}
          selected={selected}
          onSelect={setSelected}
          onCreate={(preset) => setCreating({ preset })}
          onViewChange={changeView}
          onFilterBy={(key) => bar.current?.filterBy(key)}
          onOpen={rememberList}
        />
      </div>

      {selected.size > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 z-30 flex justify-center">
          <div className="border-c-line2 bg-c-raised pointer-events-auto flex items-center gap-1 rounded-xl border p-1 shadow-xl shadow-black/15">
            <span className="px-2 font-medium tabular-nums">{selected.size} selected</span>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              <X className="size-3.5" /> Clear
            </Button>
            <Button variant="danger" onClick={deleteSelected}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </div>
        </div>
      )}

      {view.type === 'table' && (page > 1 || hasMore) && (
        <footer className="border-c-line text-c-fg2 flex h-9 shrink-0 items-center justify-end gap-2 border-t px-3 text-xs">
          <span className="tabular-nums">
            {((page - 1) * 50 + 1).toLocaleString()}–{Math.min(page * 50, total).toLocaleString()}{' '}
            of {total.toLocaleString()}
          </span>
          <Button
            size="sm"
            disabled={page <= 1}
            onClick={() =>
              navigate({ search: (prev) => ({ ...prev, page: page > 2 ? page - 1 : undefined }) })
            }
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={!hasMore}
            onClick={() => navigate({ search: (prev) => ({ ...prev, page: page + 1 }) })}
          >
            Next
          </Button>
        </footer>
      )}
      {view.type === 'board' && hasMore && (
        <footer className="border-c-line text-c-fg2 flex h-9 shrink-0 items-center border-t px-3 text-xs">
          Showing the first 500 of {total.toLocaleString()}. Add a filter to narrow the board.
        </footer>
      )}

      <NewRecordDialog
        open={creating !== null || openNew === true}
        onClose={() => {
          setCreating(null)

          if (openNew) {
            void navigate({ search: (prev) => ({ ...prev, new: undefined }), replace: true })
          }
        }}
        objectKey={object}
        obj={obj}
        titles={titles}
        // A record created from a filtered view starts out matching it, so it
        // shows up where it was created (e.g. on this pipeline's board).
        preset={{
          ...Object.fromEntries(
            Object.entries(pinnedValues(filters)).flatMap(([key, value]) => {
              const field = obj.fields[key]
              return field ? [[inputName(key, field), value]] : []
            }),
          ),
          ...creating?.preset,
        }}
      />
      <ImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        objectKey={object}
        obj={obj}
      />
    </>
  )
}

const ViewIcon = ({ type }: { type: ResolvedView['type'] }) =>
  type === 'board' ? (
    <Kanban className="size-3.5 text-orange-500" />
  ) : (
    <Table2 className="size-3.5 text-emerald-500" />
  )

/** The view switcher: pick, create, rename, duplicate, delete or reset views. */
function ViewMenu({
  object,
  views,
  view,
  onChanged,
}: {
  object: string
  views: ResolvedView[]
  view: ResolvedView
  onChanged: () => Promise<void> | void
}) {
  const navigate = route.useNavigate()
  const [open, setOpen] = useState(false)
  const go = (id: string) => navigate({ search: { view: id } })

  async function create(type: ResolvedView['type'], copyFrom?: string) {
    setOpen(false)

    const label = window.prompt(
      'Name this view',
      copyFrom ? `${view.label} copy` : type === 'board' ? 'New board' : 'New table',
    )

    if (!label?.trim()) {
      return
    }

    const { id } = await createViewFn({
      data: { objectKey: object, label: label.trim(), type, copyFrom },
    })

    await go(id)
  }

  async function rename() {
    setOpen(false)
    const label = window.prompt('Rename view', view.label)

    if (!label?.trim() || label === view.label) {
      return
    }

    await saveViewFn({
      data: { objectKey: object, viewId: view.id, patch: { label: label.trim() } },
    })

    await onChanged()
  }

  async function remove() {
    setOpen(false)
    const saved = view.source === 'saved'

    if (
      !window.confirm(
        saved
          ? `Delete the view "${view.label}"?`
          : `Reset "${view.label}" to its default columns, sort and filters?`,
      )
    ) {
      return
    }

    await deleteViewFn({ data: { objectKey: object, viewId: view.id } })

    if (saved) {
      await go(views[0]?.id ?? '')
    } else {
      await onChanged()
    }
  }

  return (
    <div className="relative" data-guide="view-menu">
      <Button onClick={() => setOpen(!open)}>
        <ViewIcon type={view.type} /> {view.label} <ChevronDown className="text-c-fg3 size-3" />
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-64">
        <MenuLabel>Views</MenuLabel>
        {views.map((v) => (
          <MenuItem
            key={v.id}
            active={v.id === view.id}
            trailing={v.id === view.id ? <Check className="text-c-accent size-3.5" /> : undefined}
            onSelect={() => {
              setOpen(false)
              void go(v.id)
            }}
          >
            <ViewIcon type={v.type} /> <span className="truncate">{v.label}</span>
          </MenuItem>
        ))}
        <MenuDivider />
        <MenuItem onSelect={() => create('table')}>
          <Plus className="text-c-fg2 size-3.5" /> New table view
        </MenuItem>
        <MenuItem onSelect={() => create('board')}>
          <Plus className="text-c-fg2 size-3.5" /> New board view
        </MenuItem>
        <MenuDivider />
        <MenuItem onSelect={rename}>
          <Pencil className="text-c-fg2 size-3.5" /> Rename
        </MenuItem>
        <MenuItem onSelect={() => create(view.type, view.id)}>
          <Copy className="text-c-fg2 size-3.5" /> Duplicate
        </MenuItem>
        {view.source === 'saved' ? (
          <MenuItem danger onSelect={remove}>
            <Trash2 className="size-3.5" /> Delete view
          </MenuItem>
        ) : (
          view.customised && (
            <MenuItem onSelect={remove}>
              <RotateCcw className="text-c-fg2 size-3.5" /> Reset to default
            </MenuItem>
          )
        )}
      </Popover>
    </div>
  )
}

type Obj = ReturnType<typeof useCrmObject>['obj']
type ViewPatch = Partial<ViewSettings> & { label?: string }
type ChangeView = (patch: ViewPatch) => Promise<void>

const toggleList = (list: string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key]

/** Columns for tables; grouping and card fields for boards. */
function ViewSettingsMenu({
  obj,
  view,
  onChange,
}: {
  obj: Obj
  view: ResolvedView
  onChange: ChangeView
}) {
  const [open, setOpen] = useState(false)
  const all = Object.keys(obj.fields)
  const columnable = [...all, ...Object.keys(SYSTEM_COLUMNS)]
  const { columns, cardFields, groupBy } = view.settings

  const move = (key: string, by: number) => {
    const next = [...columns]
    const from = next.indexOf(key)
    const to = from + by

    if (from < 1 || to < 1 || to >= next.length) {
      return
    } // the first column stays first

    next.splice(to, 0, ...next.splice(from, 1))
    void onChange({ columns: next })
  }

  return (
    <div className="relative" data-guide="view-settings">
      <Button onClick={() => setOpen(!open)}>
        <SlidersHorizontal className="text-c-fg2 size-3.5" /> View settings{' '}
        <ChevronDown className="text-c-fg3 size-3" />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        className="max-h-[70vh] w-72 overflow-y-auto"
      >
        {view.type === 'table' ? (
          <>
            <MenuLabel>Shown columns</MenuLabel>
            {columns.map((key, i) => {
              const field = obj.fields[key]
              const Icon = field ? fieldTypeIcons[field.type] : Table2
              return (
                <div
                  key={key}
                  className="hover:bg-c-hov flex items-center gap-2 rounded-lg px-2 py-1"
                >
                  <Icon className="text-c-fg3 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{columnLabel(key, field)}</span>
                  {i > 0 && (
                    <>
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={i === 1}
                        onClick={() => move(key, -1)}
                        className="text-c-fg3 hover:text-c-fg px-1 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={i === columns.length - 1}
                        onClick={() => move(key, 1)}
                        className="text-c-fg3 hover:text-c-fg px-1 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label="Hide column"
                        onClick={() => onChange({ columns: columns.filter((k) => k !== key) })}
                        className="text-c-fg3 hover:text-c-fg px-1"
                      >
                        <X className="size-3" />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {columnable.some((k) => !columns.includes(k)) && <MenuLabel>Hidden columns</MenuLabel>}
            {columnable
              .filter((k) => !columns.includes(k))
              .map((key) => {
                const field = fieldOf(obj, key)
                const Icon = field ? fieldTypeIcons[field.type] : Table2
                return (
                  <MenuItem
                    key={key}
                    onSelect={() => onChange({ columns: [...columns, key] })}
                    trailing={<Plus className="text-c-fg3 size-3" />}
                  >
                    <Icon className="text-c-fg3 size-3.5" />{' '}
                    <span className="text-c-fg2 truncate">{columnLabel(key, field)}</span>
                  </MenuItem>
                )
              })}
          </>
        ) : (
          <>
            <MenuLabel>Group by</MenuLabel>
            {all
              .filter((k) => obj.fields[k]?.type === 'select')
              .map((key) => (
                <MenuItem
                  key={key}
                  onSelect={() => onChange({ groupBy: key })}
                  trailing={
                    groupBy === key ? <Check className="text-c-accent size-3.5" /> : undefined
                  }
                >
                  {columnLabel(key, obj.fields[key])}
                </MenuItem>
              ))}
            <MenuDivider />
            <MenuLabel>Fields on cards</MenuLabel>
            {all
              .filter(
                (k) => k !== obj.titleField && k !== groupBy && obj.fields[k]?.type !== 'longtext',
              )
              .map((key) => (
                <MenuItem
                  key={key}
                  onSelect={() => onChange({ cardFields: toggleList(cardFields, key) })}
                  trailing={
                    cardFields.includes(key) ? (
                      <Check className="text-c-accent size-3.5" />
                    ) : undefined
                  }
                >
                  {columnLabel(key, obj.fields[key])}
                </MenuItem>
              ))}
          </>
        )}
      </Popover>
    </div>
  )
}

const chip =
  'flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-c-line2 px-2 hover:bg-c-hov'

/** The sort in force. Choosing a field sorts by it alone; "then by" adds a level, up to three. */
function SortChip({
  obj,
  sort,
  onChange,
}: {
  obj: Obj
  sort: Sort[]
  onChange: (next: Sort[]) => void
}) {
  const [open, setOpen] = useState(false)

  const sortable = [
    ...Object.keys(obj.fields).filter((k) => obj.fields[k]?.type !== 'relations'),
    ...Object.keys(SYSTEM_COLUMNS).filter((k) => k !== 'createdBy'),
  ]

  const label = (key: string) => columnLabel(key, fieldOf(obj, key))
  const [first, ...rest] = sort
  return (
    <div className="relative" data-guide="sort">
      <button type="button" onClick={() => setOpen(!open)} className={chip}>
        <ArrowUpDown className="text-c-fg3 size-3.5" />
        {first ? (
          <>
            <span className="text-c-fg2 hidden sm:inline">Sorted by</span>
            <span className="font-medium">{label(first.field)}</span>
            <span className="text-c-fg3">{first.dir === 'asc' ? '↑' : '↓'}</span>
            {rest.length > 0 && <span className="text-c-fg3">+{rest.length}</span>}
          </>
        ) : (
          <span className="text-c-fg2">Sort</span>
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="max-h-96 w-64 overflow-y-auto">
        {sort.length > 0 && (
          <>
            <MenuLabel>Sorted by</MenuLabel>
            {sort.map((level, i) => (
              <div key={level.field} className="flex items-center gap-1 rounded-lg px-2 py-1">
                <span className="min-w-0 flex-1 truncate">
                  {i > 0 && <span className="text-c-fg3">then </span>}
                  {label(level.field)}
                </span>
                <button
                  type="button"
                  aria-label={`Sort ${label(level.field)} ${level.dir === 'asc' ? 'descending' : 'ascending'}`}
                  onClick={() =>
                    onChange(
                      sort.map((x, j) =>
                        j === i ? { ...x, dir: x.dir === 'asc' ? 'desc' : 'asc' } : x,
                      ),
                    )
                  }
                  className="text-c-accent hover:bg-c-hov rounded px-1.5"
                >
                  {level.dir === 'asc' ? '↑' : '↓'}
                </button>
                <button
                  type="button"
                  aria-label={`Stop sorting by ${label(level.field)}`}
                  onClick={() => onChange(sort.filter((_, j) => j !== i))}
                  className="text-c-fg3 hover:bg-c-hov hover:text-c-fg rounded p-1"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <MenuDivider />
          </>
        )}
        <MenuLabel>{sort.length > 0 && sort.length < MAX_SORTS ? 'Then by' : 'Sort by'}</MenuLabel>
        {sortable
          .filter((key) => !sort.some((x) => x.field === key))
          .map((key) => (
            <MenuItem
              key={key}
              onSelect={() => {
                setOpen(false)

                // A full list of levels starts over; otherwise the field is added after the ones there.
                onChange(
                  sort.length >= MAX_SORTS
                    ? [{ field: key, dir: 'asc' }]
                    : [...sort, { field: key, dir: 'asc' }],
                )
              }}
            >
              {label(key)}
            </MenuItem>
          ))}
      </Popover>
    </div>
  )
}
