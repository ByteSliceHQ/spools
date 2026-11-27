import { Check, ChevronDown, X } from 'lucide-react'
import { type RefObject, useEffect, useId, useRef, useState } from 'react'

import { linksChange, writeLinksChange } from '../links-form'
import { cx, inputClass, useDismiss } from './kit'
import { relationTitle, searchRelation } from './session'
import { useCrmConfig } from './use-crm'

/**
 * Choosing a related record. An object can hold any number of records, so the
 * choices are never sent with the page: the picker asks the server for one page
 * of titles when it opens, and again for what is typed into it. Used by the
 * record form, the inline editor and the list filter.
 */

export type Picked = { id: string; title: string }

/**
 * Titles a page already holds for related records, by object key. Not a list of
 * choices: it only saves asking for the name of a value that is already set.
 */
export type RelationTitles = Record<string, Picked[]>

/** How long typing must pause before the server is asked. */
const DEBOUNCE_MS = 200

/**
 * The title of a related record that is only known by its id. Read from
 * `titles` when the page has it, otherwise asked for. `undefined` while that
 * is on its way, `null` when there is no such record.
 */
export function useRelationTitle(
  objectKey: string | undefined,
  id: string | undefined,
  titles?: RelationTitles,
): string | null | undefined {
  const known = objectKey && id ? titles?.[objectKey]?.find((o) => o.id === id)?.title : undefined
  const [asked, setAsked] = useState<{ objectKey: string; id: string; title: string | null }>()

  useEffect(() => {
    if (!objectKey || !id || known !== undefined) {
      return undefined
    }

    let stale = false

    relationTitle(objectKey, id).then(
      (title) => {
        if (!stale) {
          setAsked({ objectKey, id, title })
        }
      },
      // Left as "on its way": the value is still set, only its name is missing.
      () => undefined,
    )

    return () => {
      stale = true
    }
  }, [objectKey, id, known])

  if (known !== undefined) {
    return known
  }

  return asked && asked.objectKey === objectKey && asked.id === id ? asked.title : undefined
}

type SearchProps = {
  /** The object whose records are offered. */
  objectKey: string
  /** The id of the record chosen now, if any. */
  selected?: string
  /** Its title, when known: it is listed first even if it isn't on the first page of results. */
  selectedTitle?: string
  /**
   * For a field that holds many records: the ids chosen now. Each is ticked,
   * and choosing one again is how it is taken away, so the search stays open.
   */
  selectedIds?: readonly string[]
  /**
   * Told the ids of the records listed, each time results arrive. For a field
   * that may hold more than `selectedIds` says: its owner asks which of these
   * are held too.
   */
  onOptions?: (ids: readonly string[]) => void
  /** Offer to clear the choice. */
  clearable?: boolean
  /** A record was chosen, or the choice was cleared (`null`). */
  onPick: (picked: Picked | null) => void
  /** Escape was pressed. */
  onEscape: () => void
  /** Sizes the list of results; it scrolls beyond this. */
  listClassName?: string
}

/**
 * A search box over one object's records, and what it found. Arrow keys move
 * through the results, Enter chooses, Escape leaves. Where it sits (a floating
 * panel, a menu) is its parent's business.
 */
export function RelationSearch({
  objectKey,
  selected,
  selectedTitle,
  selectedIds,
  onOptions,
  clearable,
  onPick,
  onEscape,
  listClassName = 'max-h-60',
}: SearchProps) {
  // The latest one is called when results arrive, without asking again because its owner drew again.
  const listed = useRef(onOptions)
  listed.current = onOptions

  const isChosen = (id: string) => (selectedIds ? selectedIds.includes(id) : id === selected)

  const plural = useCrmConfig().objects[objectKey]?.labelPlural.toLowerCase() ?? 'records'
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')

  const [found, setFound] = useState<{
    objectKey: string
    q: string
    options: Picked[]
    more: boolean
  }>()

  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(0)
  const q = query.trim()

  useEffect(() => {
    let stale = false

    // Opening the picker asks at once; typing waits for a pause.
    const timer = setTimeout(
      () => {
        searchRelation(objectKey, q).then(
          (res) => {
            if (stale) {
              return
            }

            setFound({ objectKey, q, options: res.options, more: res.more })
            setFailed(false)
            setActive(0)
            listed.current?.(res.options.map((o) => o.id))
          },
          () => {
            if (!stale) {
              setFailed(true)
            }
          },
        )
      },
      q === '' ? 0 : DEBOUNCE_MS,
    )

    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [objectKey, q])

  // Results for an earlier search stay on screen, dimmed, until the ones for what is typed now arrive.
  const current = found?.objectKey === objectKey ? found : undefined
  const settled = current?.q === q && !failed

  // Before anything is typed, the record chosen now leads the list: it may be far from the first page.
  const chosen =
    current?.q === '' &&
    selected &&
    selectedTitle !== undefined &&
    !current.options.some((o) => o.id === selected)
      ? [{ id: selected, title: selectedTitle }]
      : []

  const options = [...chosen, ...(current?.options ?? [])]
  const activeId = options[active] ? `${listId}-${active}` : undefined

  // The panel grows when results arrive: keep it, and the option the keys are on, in view.
  // Runs when the results change, which is when the panel's size does.
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest' })
  }, [current])

  useEffect(() => {
    if (activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeId])

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Catches Escape from anything inside the picker.
    <div
      ref={root}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') {
          return
        }

        // Keep a dialog or menu around the picker open: Escape closes the picker only.
        e.preventDefault()
        e.stopPropagation()
        onEscape()
      }}
    >
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- The picker opens in response to a click or key press on its field.
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={`Search ${plural}`}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setActive((i) => Math.max(0, Math.min(options.length - 1, i + step)))
          } else if (e.key === 'Enter') {
            // Never submits the form around it, and never chooses from results for an earlier search.
            e.preventDefault()
            const option = options[active]

            if (settled && option) {
              onPick(option)
            }
          }
        }}
        placeholder={`Search ${plural}…`}
        className="border-c-line text-c-fg placeholder:text-c-fg3 w-full border-b bg-transparent px-3 py-2 text-[13px] outline-none"
      />
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Only keeps the caret in the search box when the list is clicked. */}
      <div
        onMouseDown={(e) => e.preventDefault()}
        className={cx('overflow-y-auto p-1', listClassName, !settled && current && 'opacity-60')}
      >
        <div
          id={listId}
          role="listbox"
          aria-label={plural}
          aria-multiselectable={selectedIds ? true : undefined}
          tabIndex={-1}
        >
          {options.map((o, i) => (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Focus stays in the search box, which handles the arrow keys and Enter.
            <div
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={isChosen(o.id)}
              tabIndex={-1}
              onClick={() => onPick(o)}
              onPointerMove={() => setActive(i)}
              className={cx(
                'flex w-full cursor-default items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-c-fg',
                i === active && 'bg-c-hov',
              )}
            >
              <span className="truncate">{o.title}</span>
              {isChosen(o.id) && <Check className="text-c-accent size-3.5 shrink-0" />}
            </div>
          ))}
        </div>
        <div role="status" className="text-c-fg3 text-[13px]">
          {failed ? (
            <div className="px-2 py-1.5">
              Could not search. Check your connection and type again.
            </div>
          ) : !current ? (
            <div className="px-2 py-1.5">Searching…</div>
          ) : options.length === 0 ? (
            <div className="px-2 py-1.5">{current.q ? 'No matches' : `No ${plural} yet`}</div>
          ) : null}
        </div>
      </div>
      {current?.more && (
        <div className="border-c-line text-c-fg3 border-t px-3 py-1.5 text-xs">
          Showing the first {current.options.length}. Type to find others.
        </div>
      )}
      {clearable && selected && (
        <button
          type="button"
          onClick={() => onPick(null)}
          className="border-c-line text-c-fg2 hover:bg-c-hov flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[13px]"
        >
          <X className="size-3.5" /> Clear
        </button>
      )}
    </div>
  )
}

/**
 * The search as a floating panel under its parent (which must be `relative`).
 * It closes on Escape, on a press outside it, and when focus leaves it.
 */
export function RelationPopover({
  anchor,
  align = 'left',
  className = 'w-60',
  onClose,
  ...search
}: Omit<SearchProps, 'onEscape'> & {
  /** What counts as inside, when the panel belongs to a field with its own button. Defaults to the panel. */
  anchor?: RefObject<HTMLElement | null>
  /** Which edge of the parent the panel lines up with (right inside narrow panels). */
  align?: 'left' | 'right'
  className?: string
  /** `escape` when the keyboard closed it, so focus can go back to where it was opened from. */
  onClose: (how: 'escape' | 'away') => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(anchor ?? ref, () => onClose('away'))
  return (
    // Watches focus leaving the panel; nothing here is clicked.
    <div
      ref={ref}
      onBlur={(e) => {
        const inside = anchor?.current ?? e.currentTarget

        if (!inside.contains(e.relatedTarget)) {
          onClose('away')
        }
      }}
      className={cx(
        'absolute top-full z-40 mt-1 rounded-xl border border-c-line2 bg-c-raised shadow-xl shadow-black/10',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
    >
      <RelationSearch {...search} onEscape={() => onClose('escape')} />
    </div>
  )
}

/**
 * A relation field in a form: a button showing the chosen record, which opens
 * the search. The id travels with the form under `name`, like any other field.
 */
export function RelationInput({
  objectKey,
  name,
  value,
  required,
  titles,
}: {
  objectKey: string
  /** Form control name; also the id a `<label htmlFor>` points at. */
  name: string
  /** The id of the record chosen when the form opens. */
  value: string
  required: boolean
  titles?: RelationTitles
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  const [picked, setPicked] = useState<{ id: string; title?: string } | null>(
    value ? { id: value } : null,
  )

  const [open, setOpen] = useState(false)

  const looked = useRelationTitle(
    objectKey,
    picked && picked.title === undefined ? picked.id : undefined,
    titles,
  )

  const title = picked?.title ?? looked
  const valueId = useId()

  return (
    // Watches focus leaving the field; the button inside is what is clicked.
    <div
      ref={wrap}
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <button
        ref={trigger}
        id={name}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        // The label names the field; this reads out what is chosen.
        aria-describedby={valueId}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={cx(inputClass, 'text-left')}
      >
        <span className="flex items-center justify-between gap-2">
          <span id={valueId} className={cx('min-w-0 truncate', !picked && 'text-c-fg3')}>
            {picked ? (title ?? (title === null ? 'Unknown record' : '…')) : '—'}
          </span>
          <ChevronDown className="text-c-fg3 size-3.5 shrink-0" />
        </span>
      </button>
      {/* Carries the id in the form's data, and lets the browser insist on a required field. */}
      <input
        tabIndex={-1}
        aria-hidden="true"
        name={name}
        value={picked?.id ?? ''}
        required={required}
        onChange={() => undefined}
        onFocus={() => trigger.current?.focus()}
        className="pointer-events-none absolute bottom-0 left-0 h-px w-full opacity-0"
      />
      {open && (
        <RelationPopover
          anchor={wrap}
          className="w-full"
          objectKey={objectKey}
          selected={picked?.id}
          selectedTitle={title ?? undefined}
          clearable={!required}
          onPick={(p) => {
            setPicked(p)
            setOpen(false)
            trigger.current?.focus()
          }}
          onClose={(how) => {
            setOpen(false)

            if (how === 'escape') {
              trigger.current?.focus()
            }
          }}
        />
      )}
    </div>
  )
}

/** One chosen record of a relations field: its title, and a button that takes it away. */
function PickedChip({
  objectKey,
  picked,
  titles,
  onRemove,
}: {
  objectKey: string
  picked: { id: string; title?: string | undefined }
  titles?: RelationTitles | undefined
  onRemove: () => void
}) {
  const looked = useRelationTitle(
    objectKey,
    picked.title === undefined ? picked.id : undefined,
    titles,
  )

  const title = picked.title ?? looked ?? (looked === null ? 'Unknown record' : '…')

  return (
    <span className="bg-c-hov text-c-fg flex max-w-full items-center gap-1 rounded-md py-0.5 pr-1 pl-1.5 text-xs font-medium">
      <span className="truncate">{title}</span>
      <button
        type="button"
        aria-label={`Remove ${title}`}
        onClick={onRemove}
        className="text-c-fg3 hover:text-c-fg rounded p-0.5"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

/**
 * A relations field in a form: the records chosen, each with a button that
 * takes it away, and a button that opens the search to add more. The search
 * stays open while records are ticked and unticked.
 *
 * What travels with the form under `name` is the change, not the set:
 * `{"add":[…],"remove":[…]}` against what the saved record holds (`held`). A
 * record can hold more than a page shows (`total`), and the ones not shown
 * must stay as they are. A new record holds nothing, so what its form starts
 * with (`value` from a preset) is all to add.
 */
export function RelationsInput({
  objectKey,
  name,
  value,
  held,
  total,
  titles,
}: {
  objectKey: string
  /** Form control name (`<field>Ids`); also the id a `<label htmlFor>` points at. */
  name: string
  /** The records chosen when the form opens, with their titles where the page has them. */
  value: readonly { id: string; title?: string | undefined }[]
  /** The ids among them that the saved record holds already. Empty for a record that is being made. */
  held: readonly string[]
  /** How many the record holds in all, when that is more than `value`. */
  total?: number | undefined
  titles?: RelationTitles | undefined
}) {
  const plural = useCrmConfig().objects[objectKey]?.labelPlural.toLowerCase() ?? 'records'
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [saved] = useState(() => [...held])
  const [picked, setPicked] = useState<{ id: string; title?: string | undefined }[]>([...value])
  const [open, setOpen] = useState(false)
  const ids = picked.map((p) => p.id)
  const hidden = Math.max(0, (total ?? 0) - saved.length)
  const change = linksChange(saved, ids)

  const toggle = (option: Picked) =>
    setPicked((now) =>
      now.some((p) => p.id === option.id)
        ? now.filter((p) => p.id !== option.id)
        : [...now, option],
    )

  return (
    // Watches focus leaving the field; the buttons inside are what is clicked.
    <div
      ref={wrap}
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setOpen(false)
        }
      }}
    >
      <div className={cx(inputClass, 'flex h-auto min-h-8 flex-wrap items-center gap-1 py-1')}>
        {picked.map((p) => (
          <PickedChip
            key={p.id}
            objectKey={objectKey}
            picked={p}
            titles={titles}
            onRemove={() => setPicked((now) => now.filter((other) => other.id !== p.id))}
          />
        ))}
        {hidden > 0 && <span className="text-c-fg3 text-xs">and {hidden} more</span>}
        <button
          ref={trigger}
          id={name}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
            }
          }}
          className="text-c-fg2 hover:text-c-fg flex items-center gap-1 rounded-md px-1 py-0.5 text-xs"
        >
          <ChevronDown className="text-c-fg3 size-3.5 shrink-0" />
          {picked.length === 0 && hidden === 0 ? `Choose ${plural}` : 'Add or remove'}
        </button>
      </div>
      <input type="hidden" name={name} value={writeLinksChange(change)} />
      {open && (
        <RelationPopover
          anchor={wrap}
          className="w-full"
          objectKey={objectKey}
          selectedIds={ids}
          onPick={(option) => {
            if (option) {
              toggle(option)
            }
          }}
          onClose={(how) => {
            setOpen(false)

            if (how === 'escape') {
              trigger.current?.focus()
            }
          }}
        />
      )}
    </div>
  )
}
