import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'

/**
 * Positions are short strings that sort in order ("a0" < "a0V" < "a1"). There is always room between two
 * of them, so moving an item writes only that item, and inserts never run out of space the way halving
 * numbers does. Compare with `<`, not localeCompare.
 */
export const comparePositions = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A position between `before` and `after` (either can be null for "the start" / "the end"). */
export const positionBetween = (before: string | null | undefined, after: string | null | undefined) =>
  generateKeyBetween(before ?? null, after ?? null)

/** `n` evenly spread positions between `before` and `after`. */
export const positionsBetween = (before: string | null | undefined, after: string | null | undefined, n: number) =>
  generateNKeysBetween(before ?? null, after ?? null, n)

/** Whether `key` is a position this module could have made (anything else would break inserts next to it). */
export function isPosition(key: string): boolean {
  if (!/^[0-9A-Za-z]{1,200}$/.test(key)) return false
  try {
    generateKeyBetween(key, null)
    return true
  } catch {
    return false
  }
}
