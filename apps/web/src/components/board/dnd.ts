/**
 * Drag-and-drop helpers for the board (the dragging itself is lib/pointerDrag.ts).
 * What's being dragged is kept here, for the drop markers.
 */

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

/**
 * Where a pointer at `y` would insert among the `item` elements inside `container`. The dragged one is hidden but still
 * counted. Over the drop marker (`slot`), the answer is where the marker already is, so it only moves once the pointer
 * passes the middle of what's next to it.
 */
function indexAt(container: HTMLElement, y: number, item: string, slot: string): number {
  let i = 0
  for (const el of container.querySelectorAll<HTMLElement>(`${item}, ${slot}`)) {
    const r = el.getBoundingClientRect()
    if (el.matches(slot)) {
      if (y < r.bottom) return i
      continue
    }
    if (r.height && y < r.top + r.height / 2) return i
    i++
  }
  return i
}

/** Among the cards (`[data-card-id]`) inside `container`. */
export const cardIndexAt = (container: HTMLElement, y: number) => indexAt(container, y, '[data-card-id]', '[data-drop-slot]')

/** Among a grouped list's items (`[data-item]`: cards without a parent header, and groups). */
export const itemIndexAt = (container: HTMLElement, y: number) => indexAt(container, y, '[data-item]', '[data-item-slot]')

/** Where a pointer at `x` would insert among the `[data-list-id]` elements inside `container`. */
export function listIndexAt(container: HTMLElement, x: number): number {
  const lists = container.querySelectorAll<HTMLElement>('[data-list-id]')
  for (let i = 0; i < lists.length; i++) {
    const r = lists[i].getBoundingClientRect()
    if (x < r.left + r.width / 2) return i
  }
  return lists.length
}
