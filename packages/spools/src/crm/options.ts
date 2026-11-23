/**
 * Select options that depend on another field (a `stage` that depends on
 * `pipeline`), and the win probabilities used for weighted totals. Shared by
 * server and client: no Zod, so it stays out of the browser's config bundle.
 */

type Option = { value: string; label?: string; probability?: number; when?: string[] }
type Field = {
  type: string
  label?: string
  required?: boolean
  default?: string | number | boolean
  options?: Option[]
  dependsOn?: string
}
type SelectField = Field & { options: Option[] }

const isSelect = (field: Field | undefined): field is SelectField =>
  field?.type === 'select' && Array.isArray(field.options)

/**
 * The options of `field` that apply while its controlling field holds
 * `controlling`. A field without `dependsOn` always offers every option; with
 * the controlling field empty, only the options that aren't scoped by `when`.
 * The controlling value is whatever the record holds there; it is only ever
 * compared with the option values in `when`, so anything that isn't one of
 * them (a number, nothing at all) leaves just the unscoped options.
 */
export function allowedOptions<O extends Option>(
  field: { options: O[]; dependsOn?: string },
  controlling: unknown,
): O[] {
  if (!field.dependsOn) {
    return field.options
  }

  return field.options.filter((o) => !o.when || o.when.some((value) => value === controlling))
}

/** The select fields other fields depend on, e.g. `pipeline`. */
export function controllingFields(fields: Record<string, Field>): Set<string> {
  const keys = new Set<string>()

  for (const field of Object.values(fields)) {
    if (isSelect(field) && field.dependsOn) {
      keys.add(field.dependsOn)
    }
  }

  return keys
}

/** True when a change to any of `keys` could make a dependent option invalid. */
export function touchesDependents(fields: Record<string, Field>, keys: string[]): boolean {
  const controlling = controllingFields(fields)
  return keys.some((k) => controlling.has(k) || (isSelect(fields[k]) && !!fields[k].dependsOn))
}

export type DependentIssue = { field: string; message: string }

/** A record value, or what reconciling put in its place: a field's default, an option, or null. */
type Settled<V> = V | Field['default'] | null

/** Record values with dependent selects settled, and what stopped a value the caller set. */
export type Reconciled<V> = { values: Record<string, Settled<V>>; issues: DependentIssue[] }

/**
 * Keep dependent selects consistent with their controlling field.
 *
 * `values` is what is about to be written (after parsing); `previous` is the
 * stored record on an update. A dependent value the caller set must be allowed,
 * otherwise an issue is returned. A dependent value the caller left alone is
 * moved to the first allowed option when a change to the controlling field made
 * it invalid, so switching pipeline never strands a record on another
 * pipeline's stage. On create, an empty dependent takes its default if that is
 * allowed, or else the first allowed option.
 *
 * Values are compared with option values, copied and quoted in messages, never
 * looked inside, so they keep whatever type the caller gave them (`V` for the
 * values being written, `P` for the stored record's).
 */
export function reconcileDependents<V, P = V>(
  fields: Record<string, Field>,
  values: Record<string, V>,
  previous?: Record<string, P>,
): Reconciled<V | P> {
  const out = new Map<string, Settled<V | P>>(Object.entries(values))
  const issues: DependentIssue[] = []
  const name = (key: string) => fields[key]?.label ?? key
  const blank = (value: Settled<V | P>) => value === null || value === undefined || value === ''

  for (const [key, field] of Object.entries(fields)) {
    if (!isSelect(field) || !field.dependsOn) {
      continue
    }

    const control = field.dependsOn
    const controlling = out.has(control) ? out.get(control) : previous?.[control]
    const allowed = allowedOptions(field, controlling)
    const isAllowed = (v: Settled<V | P>) => allowed.some((o) => o.value === v)
    const set = Object.hasOwn(values, key) && !blank(values[key])

    if (set) {
      if (!isAllowed(values[key])) {
        const option = field.options.find((o) => o.value === values[key])

        const controlLabel = isSelect(fields[control])
          ? (fields[control].options.find((o) => o.value === controlling)?.label ?? controlling)
          : controlling

        issues.push({
          field: key,
          message: blank(controlling)
            ? `"${option?.label ?? String(values[key])}" needs ${name(control)} to be set first`
            : `"${option?.label ?? String(values[key])}" is not a ${name(key)} option when ${name(control)} is "${String(controlLabel)}"`,
        })
      }

      continue
    }

    if (!previous) {
      // Create: fall back to the default, then to the first option that applies.
      const wantsValue = field.default !== undefined || field.required === true

      if (wantsValue) {
        out.set(key, isAllowed(field.default) ? field.default : (allowed[0]?.value ?? null))
      }

      continue
    }

    // Update: only step in when the controlling field changed under a stored value.
    const explicitlyCleared = Object.hasOwn(values, key)
    const stored = previous[key]

    if (
      !explicitlyCleared &&
      Object.hasOwn(values, control) &&
      !blank(stored) &&
      !isAllowed(stored)
    ) {
      out.set(key, allowed[0]?.value ?? null)
    }
  }

  return { values: Object.fromEntries(out), issues }
}

/** `amount` scaled by an option's win probability; unchanged when the option has none. */
export function weighted(amount: number, option: { probability?: number } | undefined): number {
  return option?.probability === undefined ? amount : (amount * option.probability) / 100
}

/** True when any option carries a probability, i.e. a weighted total is meaningful. */
export const hasProbabilities = (field: { options: Option[] } | undefined): boolean =>
  !!field?.options.some((o) => o.probability !== undefined)
