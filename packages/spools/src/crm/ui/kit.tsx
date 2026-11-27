import { Check } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'

/** Small UI primitives shared by the CRM screens. */

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(' ')

type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

const buttonVariants = {
  primary: 'bg-c-accent text-white hover:bg-c-accent-hov',
  secondary: 'border border-c-line2 bg-c-raised text-c-fg hover:bg-c-hov',
  ghost: 'text-c-fg2 hover:bg-c-hov hover:text-c-fg',
  danger: 'text-c-danger hover:bg-c-hov',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-6 px-1.5 text-xs' : 'h-7 px-2.5 text-[13px]',
        buttonVariants[variant],
        className,
      )}
      {...props}
    />
  )
}

/** A square, icon-only button. `label` is read by screen readers and shown as a tooltip. */
export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonProps & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-c-fg2 transition-colors hover:bg-c-hov hover:text-c-fg disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

const avatarColors = [
  'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  'bg-pink-500/15 text-pink-700 dark:text-pink-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
]

/** Initials on a colour picked from the name, so the same record always looks the same. */
export function Avatar({
  name,
  size = 'md',
  round,
}: {
  name: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  round?: boolean
}) {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  let hash = 0

  for (const ch of name) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }

  const sizes = {
    xs: 'size-4 text-[9px]',
    sm: 'size-[18px] text-[10px]',
    md: 'size-6 text-xs',
    lg: 'size-8 text-sm',
  }

  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-semibold',
        round ? 'rounded-full' : size === 'lg' ? 'rounded-lg' : 'rounded-[5px]',
        sizes[size],
        avatarColors[hash % avatarColors.length],
      )}
    >
      {initial}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-c-line2 text-c-fg3 rounded border px-1 font-sans text-[10px] font-medium">
      {children}
    </kbd>
  )
}

/** A count next to a tab or heading. */
export function Count({ children }: { children: ReactNode }) {
  return (
    <span className="bg-c-hov text-c-fg2 rounded px-1 text-[11px] font-medium tabular-nums">
      {children}
    </span>
  )
}

/** The round check used for tasks. */
export function CheckCircle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: () => void
  label: string
  /** Shows whether it is checked, and can't be changed. */
  disabled?: boolean
}) {
  return (
    // A native checkbox can't be styled as a round check.
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cx(
        'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
        checked ? 'border-c-accent bg-c-accent text-white' : 'border-c-line2',
        disabled ? 'cursor-default opacity-60' : !checked && 'hover:border-c-fg3',
      )}
    >
      {checked && <Check className="size-2.5" strokeWidth={3.5} />}
    </button>
  )
}

/** Call `onAway` on a pointer press outside `ref`, or on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onAway: () => void, active = true) {
  const handler = useRef(onAway)
  handler.current = onAway

  useEffect(() => {
    if (!active) {
      return undefined
    }

    const onPointer = (e: PointerEvent) => {
      // A press on something that is not a node (the window itself) is outside by definition.
      if (ref.current && !(e.target instanceof Node && ref.current.contains(e.target))) {
        handler.current()
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handler.current()
      }
    }

    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, active])
}

/** A floating panel anchored under its parent (which must be `relative`). */
export function Popover({
  open,
  onClose,
  align = 'left',
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  align?: 'left' | 'right'
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onClose, open)

  if (!open) {
    return null
  }

  return (
    <div
      ref={ref}
      className={cx(
        'absolute top-full z-40 mt-1 min-w-56 rounded-xl border border-c-line2 bg-c-raised p-1 shadow-xl shadow-black/10',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function MenuItem({
  children,
  onSelect,
  active,
  danger,
  trailing,
}: {
  children: ReactNode
  onSelect: () => void
  active?: boolean
  danger?: boolean
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-c-hov',
        danger ? 'text-c-danger' : 'text-c-fg',
        active && 'bg-c-hov',
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {trailing}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="text-c-fg3 px-2 pt-1.5 pb-1 text-[11px] font-medium">{children}</div>
}

export function MenuDivider() {
  return <div className="border-c-line -mx-1 my-1 border-t" />
}

/** A centred modal built on the native <dialog>, so focus trapping and Escape come for free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current

    if (!dialog) {
      return
    }

    if (open && !dialog.open) {
      dialog.showModal()
    }

    if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onPointerDown={(e) => {
        if (e.target === ref.current) {
          onClose()
        } // click on the backdrop
      }}
      className={cx(
        'm-auto w-full rounded-2xl border border-c-line2 bg-c-raised p-0 text-c-fg shadow-2xl',
        width,
      )}
    >
      {open && (
        <>
          <header className="border-c-line border-b px-4 py-3 text-[13px] font-semibold">
            {title}
          </header>
          <div className="max-h-[72vh] overflow-y-auto px-4 py-4">{children}</div>
        </>
      )}
    </dialog>
  )
}

const rtf =
  typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null

/** "3 minutes ago", "yesterday", "2 months ago". */
export function relativeTime(value: Date | string): string {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ]

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return rtf?.format(Math.round(seconds / size), unit) ?? ''
    }
  }

  return 'just now'
}

export const inputClass =
  'block w-full rounded-lg border border-c-line2 bg-c-raised px-2.5 py-1.5 text-[13px] text-c-fg placeholder:text-c-fg3 focus:border-c-accent focus:ring-2 focus:ring-c-accent/20 focus:outline-none'
