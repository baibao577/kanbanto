/**
 * Native drag-and-drop helpers for the board.
 * `dataTransfer` can't be read during dragover, so what's being dragged is also kept here.
 */
export const CARD_DRAG_TYPE = 'text/x-kanbanto-task'
export const LIST_DRAG_TYPE = 'text/x-kanbanto-list'
export const GROUP_DRAG_TYPE = 'text/x-kanbanto-group'

/** A parent's header being dragged: its subtasks in the list it came from. */
export interface GroupDrag {
  parentId: string
  ids: string[]
  row: string
  cell: string
}

export const dragging: { card: string | null; list: string | null; group: GroupDrag | null; height: number } = {
  card: null,
  list: null,
  group: null,
  height: 40,
}

/** Group key for grouped cells: the parent id, or '__loose' for cards without a parent header. */
export const groupAttr = (parentId: string | null) => parentId ?? '__loose'

/** Where a pointer at `y` would insert among the `[data-card-id]` elements inside `container`. */
export function cardIndexAt(container: HTMLElement, y: number): number {
  const cards = container.querySelectorAll<HTMLElement>('[data-card-id]')
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect()
    if (y < r.top + r.height / 2) return i
  }
  return cards.length
}

/** Where a pointer at `x` would insert among the `[data-list-id]` elements inside `container`. */
export function listIndexAt(container: HTMLElement, x: number): number {
  const lists = container.querySelectorAll<HTMLElement>('[data-list-id]')
  for (let i = 0; i < lists.length; i++) {
    const r = lists[i].getBoundingClientRect()
    if (x < r.left + r.width / 2) return i
  }
  return lists.length
}
