import { z } from 'zod'

/**
 * What a form sends for a relations field (`"type": "relations"`): the change,
 * not the set. A record can hold more related records than a page shows, and
 * the ones not shown must stay as they are. Pure, and used by the browser: the
 * input writes the change into the form, and the form reads it back.
 */

const changeSchema = z.object({ add: z.array(z.string()), remove: z.array(z.string()) })

/** The records to link and the ones to let go. */
export type LinksFormChange = z.output<typeof changeSchema>

/**
 * The change that takes a record from what it holds to what is chosen now.
 *
 * `held` is what the saved record holds, as far as the page shows it. A new
 * record holds nothing, so `held` is empty for it and everything its form
 * starts with (a preset, such as the record it is being made from) is added.
 */
export function linksChange(held: readonly string[], chosen: readonly string[]): LinksFormChange {
  const [was, is] = [new Set(held), new Set(chosen)]

  return {
    add: [...is].filter((id) => !was.has(id)),
    remove: [...was].filter((id) => !is.has(id)),
  }
}

/** A change as the input writes it into the form. */
export const writeLinksChange = (change: LinksFormChange): string => JSON.stringify(change)

/**
 * A change read back from the form. Undefined when what is there is not one:
 * the form must say so and send nothing, never take it for "no change".
 */
export function readLinksChange(written: FormDataEntryValue | null): LinksFormChange | undefined {
  const text = z.string().safeParse(written)

  if (!text.success) {
    return undefined
  }

  try {
    return changeSchema.safeParse(JSON.parse(text.data)).data
  } catch {
    // Not JSON. The caller is told there is no change to read.
    return undefined
  }
}

/**
 * Whether a record holds one of the records a picker lists, as far as the page
 * can tell. A read brings back the first of a record's links only: `shown` are
 * those, and `hidden` says how many more it holds. `asked` is what the server
 * answered about records that are not among the ones shown.
 *
 * `unknown` means the answer is still on its way. The picker must not tick the
 * record or act on a click until it is here: taking a held record for a free
 * one is how a link shows unticked and can't be let go.
 */
export function heldState(
  page: { shown: readonly string[]; hidden: number; asked: ReadonlyMap<string, boolean> },
  id: string,
): 'held' | 'free' | 'unknown' {
  const answer = page.asked.get(id)

  // What the server said last is newer than the page: a record just linked may not be among the ones shown.
  if (answer !== undefined) {
    return answer ? 'held' : 'free'
  }

  if (page.shown.includes(id)) {
    return 'held'
  }

  return page.hidden > 0 ? 'unknown' : 'free'
}
