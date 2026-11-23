/** Naming helpers shared by server and client (no Zod, keeps the browser bundle small). */

export const SYSTEM_FIELDS = ['id', 'createdAt', 'updatedAt', 'createdBy'] as const

/** The database table an object's records live in: its key in snake_case. */
export const tableName = (objectKey: string): string =>
  objectKey.replace(/([A-Z])/g, '_$1').toLowerCase()

export function modelName(objectKey: string, obj: { model?: string }): string {
  if (obj.model) {
    return obj.model
  }

  const singular = objectKey.endsWith('ies')
    ? `${objectKey.slice(0, -3)}y`
    : objectKey.endsWith('s')
      ? objectKey.slice(0, -1)
      : objectKey

  return singular.charAt(0).toUpperCase() + singular.slice(1)
}

export function fieldLabel(key: string, field?: { label?: string }): string {
  if (field?.label) {
    return field.label
  }

  const spaced = key.replace(/([A-Z])/g, ' $1')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
