import { z } from 'zod'

/** Any value JSON can hold. */
export const jsonValue = z.json()

/** A value JSON can hold: what JSON text reads as. */
export type Json = z.infer<typeof jsonValue>

/** Read JSON text, or undefined when it isn't JSON (an empty body included). */
export function parseJson(text: string): Json | undefined {
  try {
    return jsonValue.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}
