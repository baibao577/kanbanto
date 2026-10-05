import type { FieldDef } from './fields'
import { descendantsOf, type TaskIndex } from './indexer'

/**
 * Totals of number fields that add up (an amount, hours): one rule everywhere. A number counts once, on the card
 * that holds it; a card's total is its own number plus its subtasks', all the way down (the way logged time works).
 */

/** Numbers of a field added up: to the field's decimals (6 when it shows them as typed), and never "-0". */
export function sumOf(def: Pick<FieldDef, 'decimals'>, numbers: Iterable<number>): number {
  let sum = 0
  for (const n of numbers) sum += n
  const unit = 10 ** (def.decimals ?? 6)
  const rounded = Math.round(sum * unit) / unit
  return rounded === 0 ? 0 : rounded
}

/** A card's own number for a field (undefined: it has none). */
export function numberOf(idx: TaskIndex, id: string, fieldId: string): number | undefined {
  const v = idx.tasks[id]?.custom?.[fieldId]
  return typeof v === 'number' ? v : undefined
}

/** One card's total for a number field: its own number plus its subtasks'. Undefined when none of them has one. */
export function totalUnder(idx: TaskIndex, def: FieldDef, id: string): number | undefined {
  const numbers = [id, ...descendantsOf(idx, id)].flatMap((k) => numberOf(idx, k, def.id) ?? [])
  return numbers.length ? sumOf(def, numbers) : undefined
}

/**
 * Every card's total for a number field: its own number plus its subtasks'. Only cards with a number at or under
 * them are in the answer. `counted`: only these cards' numbers count (the ones a filter keeps), so a parent's total
 * and a total of everything shown always agree.
 */
export function subtreeSums(idx: TaskIndex, def: FieldDef, counted?: ReadonlySet<string>): Map<string, number> {
  const raw = new Map<string, number>()
  // Children before parents, as the index does its own roll-ups (a loop of parents can't trap this).
  for (let i = idx.preorder.length - 1; i >= 0; i--) {
    const id = idx.preorder[i]
    const own = !counted || counted.has(id) ? numberOf(idx, id, def.id) : undefined
    const below = (idx.childrenOf.get(id) ?? []).filter((k) => raw.has(k))
    if (own !== undefined || below.length)
      raw.set(
        id,
        below.reduce((sum, k) => sum + raw.get(k)!, own ?? 0),
      )
  }
  return new Map([...raw].map(([id, sum]) => [id, sumOf(def, [sum])]))
}
