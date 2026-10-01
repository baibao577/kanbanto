import type { ListOrder, ViewConfig } from '@kanbanto/model/types'

/**
 * A list shown in another order than the one made by hand (set from the list's menu). It's a display setting: the
 * order by hand is kept underneath.
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
