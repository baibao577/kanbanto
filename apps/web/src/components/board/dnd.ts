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

/** How far beside a list the pointer still counts as on it (the gap between lists, the board's edge). */
const NEAR = 24

/**
 * The cell (`[data-cell]`) of `board` a pointer at (x, y) is on. Off the cells but still on the board, it's the
 * nearest one sideways: in the gap between two lists, or below a list that's shorter than the board.
 */
export function cellAt(board: HTMLElement, x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y)
  if (!hit || !board.contains(hit)) return null
  const on = hit.closest<HTMLElement>('[data-cell]')
  if (on) return on
  // Lists side by side each reach down the whole board; in rows, only the row at the pointer's height counts.
  const lists = board.matches('[data-list-row]')
  let best: HTMLElement | null = null
  let nearest = NEAR
  for (const el of board.querySelectorAll<HTMLElement>('[data-cell]')) {
    const r = el.getBoundingClientRect()
    if (!lists && (y < r.top || y > r.bottom)) continue
    const d = Math.max(r.left - x, x - r.right, 0)
    if (d < nearest) {
      best = el
      nearest = d
    }
  }
  return best
}
