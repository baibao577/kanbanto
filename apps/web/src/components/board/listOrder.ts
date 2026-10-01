import type { ListOrder, ViewConfig } from '@kanbanto/model/types'

/**
 * How one list is shown (set from the list itself, saved with the display settings): in another order than the one
 * made by hand, which is kept underneath; or folded to a narrow strip.
 */

/** How a list's cards can be ordered, and which come first. */
export const ORDER_LABEL: Record<ListOrder, [string, string]> = {
  priority: ['Priority', 'Most important first'],
  due: ['Due date', 'Soonest first'],
  title: ['Title', 'A to Z'],
}

/** The board's display settings with list `id` shown in that order (none: by hand). */
export function withListOrder(board: ViewConfig, id: string, by: ListOrder | undefined): ViewConfig {
  const { [id]: _, ...rest } = board.listOrder ?? {}
  const next = by ? { ...rest, [id]: by } : rest
  // (No entry at all when every list is by hand, so the view still matches a preset saved that way.)
  return { ...board, listOrder: Object.keys(next).length ? next : undefined }
}

/** The board's display settings with list `id` folded to a narrow strip, or opened again. */
export function withListCollapsed(board: ViewConfig, id: string, collapsed: boolean): ViewConfig {
  const rest = (board.collapsedColumns ?? []).filter((x) => x !== id)
  const next = collapsed ? [...rest, id] : rest
  return { ...board, collapsedColumns: next.length ? next : undefined }
}
