import {
  AlignLeft,
  AtSign,
  Box,
  Briefcase,
  Building2,
  Calendar,
  CalendarClock,
  CheckSquare,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Handshake,
  Hash,
  Home,
  Link2,
  ListTodo,
  type LucideIcon,
  Network,
  Phone,
  Tag,
  Ticket,
  ToggleLeft,
  Type,
  User,
  Users,
  Waypoints,
} from 'lucide-react'

import type { FieldType } from '../field-types'

/** The icon shown beside each field type in column headers and detail panels. */
export const fieldTypeIcons = {
  text: Type,
  longtext: AlignLeft,
  email: AtSign,
  phone: Phone,
  url: Link2,
  number: Hash,
  currency: CircleDollarSign,
  boolean: ToggleLeft,
  date: Calendar,
  datetime: CalendarClock,
  select: Tag,
  relation: Waypoints,
  relations: Network,
  user: User,
} satisfies { [T in FieldType]: LucideIcon }

/** Icons an object can pick with `"icon"` in crm.config.json. */
export const objectIcons = {
  users: Users,
  user: User,
  building: Building2,
  handshake: Handshake,
  briefcase: Briefcase,
  calendar: Calendar,
  checklist: ListTodo,
  clipboard: ClipboardList,
  check: CheckSquare,
  ticket: Ticket,
  home: Home,
  file: FileText,
  box: Box,
} satisfies Record<string, LucideIcon>

export type ObjectIconName = keyof typeof objectIcons

/** Whether a name from the config is one of `objectIcons`. */
const isObjectIconName = (name: string): name is ObjectIconName => Object.hasOwn(objectIcons, name)

/** Every icon name, in order. Written as a non-empty list (`users` is the first) so it can feed `z.enum`. */
export const objectIconNames: [ObjectIconName, ...ObjectIconName[]] = [
  'users',
  ...Object.keys(objectIcons)
    .filter((name) => name !== 'users')
    .filter(isObjectIconName),
]

const objectColors = [
  'bg-blue-500',
  'bg-indigo-500',
  'bg-orange-500',
  'bg-purple-500',
  'bg-cyan-500',
  'bg-emerald-500',
  'bg-pink-500',
  'bg-amber-500',
]

/**
 * An object's icon on a small coloured square. `index` is the object's position in
 * the config, so each object keeps one colour everywhere.
 */
export function ObjectIcon({
  icon,
  index = 0,
  size = 'md',
}: {
  icon?: string
  index?: number
  size?: 'sm' | 'md' | 'lg'
}) {
  const Icon = (icon && isObjectIconName(icon) ? objectIcons[icon] : undefined) ?? Box

  const box = {
    sm: 'size-4 rounded-[4px]',
    md: 'size-[18px] rounded-[5px]',
    lg: 'size-8 rounded-lg',
  }[size]

  const glyph = { sm: 'size-2.5', md: 'size-3', lg: 'size-4.5' }[size]
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center text-white ${box} ${objectColors[index % objectColors.length]}`}
    >
      <Icon className={glyph} strokeWidth={2.25} />
    </span>
  )
}
