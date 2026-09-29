import type { Command, TaskFields } from '@kanbanto/model/commands'
import { isLeaf, wouldCycle, type TaskIndex } from '@kanbanto/model/indexer'
import type { BoardData, ViewConfig } from '@kanbanto/model/types'
import { cellKey, groupCell, groupsSubtasks, TOP_LEVEL, UNASSIGNED, type CardGroup } from '@kanbanto/model/view'
import type { GroupDrag } from './dnd'

/**
 * What dropping a card (or a parent's group of cards) on the board means: the rules, apart from the drag and drop
 * itself. Depending on the display settings, a cell (row × column) stands for a status, a parent, a person, or a
 * project, so a drop becomes a change of those, plus a position.
 */

export interface DropContext {
  data: BoardData
  idx: TaskIndex
  config: ViewConfig
  /** The board's cells: card ids per `cellKey(row, column)`, as shown. */
  cells: Map<string, string[]>
}

/** Why a card can't go somewhere (also shown on the spot while dragging). */
export const BLOCKED = {
  derived: 'Its status follows its subtasks',
  project: 'Can’t move between projects here',
  cycle: 'Can’t go inside its own subtask',
} as const
export type Blocked = (typeof BLOCKED)[keyof typeof BLOCKED]

const statusLists = (c: DropContext) => c.config.columns === 'status'
const nestedRows = (c: DropContext) => c.config.rows === 'directParent'

/** Which parent group a card sits in within a row (null = no header: top level, or the row's own task). */
export function groupOf(c: DropContext, id: string, row: string): string | null {
  const p = c.data.tasks[id]?.parentId
  return p && p in c.data.tasks && p !== row ? p : null
}

/** Why card `id` can't be dropped into (row, col), or null if it can. */
export function blockReason(c: DropContext, id: string, row: string, col: string): Blocked | null {
  const t = c.data.tasks[id]
  if (!t) return null
  if (statusLists(c) && col !== c.idx.status.get(id) && c.data.board.mode === 'derived' && !isLeaf(c.idx, id)) return BLOCKED.derived
  if (c.config.rows === 'rootParent' && row !== c.idx.rootOf.get(id)) return BLOCKED.project
  const newParent = !statusLists(c) ? col : nestedRows(c) ? (row === TOP_LEVEL ? null : row) : undefined
  if (newParent !== undefined && newParent !== t.parentId && wouldCycle(c.data.tasks, id, newParent)) return BLOCKED.cycle
  return null
}

/**
 * The command for card `id` dropped in cell (row, col) at position `at`, or null when nothing would change.
 * Check `blockReason` first.
 *
 * With subtasks grouped under their parent (see `groupCell`), `at` is a position inside the card's parent group when
 * that group is in the list, and otherwise a position among the list's items (cards without a header, and groups):
 * where the card goes, or where its new group starts.
 */
export function dropCommand(c: DropContext, id: string, row: string, col: string, at: number): Command | null {
  const t = c.data.tasks[id]
  const move: Extract<Command, { type: 'task.move' }> = { type: 'task.move', id }
  if (statusLists(c)) {
    if (col !== c.idx.status.get(id)) move.status = col
  } else if (col !== t.parentId) {
    move.parentId = col
  }

  if (nestedRows(c) && statusLists(c)) {
    const p = row === TOP_LEVEL ? null : row
    if (p !== t.parentId) move.parentId = p
  } else if (c.config.rows === 'assignee') {
    const a = row === UNASSIGNED ? null : row
    if (a !== (t.assigneeId ?? null)) move.assigneeId = a
  }

  const cell = c.cells.get(cellKey(row, col)) ?? []
  if (statusLists(c)) {
    // Status lists: free order, like Trello. Re-number this list's cards with the dropped card in place.
    let order: string[]
    if (groupsSubtasks(c.config)) {
      const key = groupOf(c, id, row)
      const items = groupCell(c.idx, cell, row)
      const group = key === null ? undefined : items.find((g) => g.parentId === key)
      if (group) {
        const pos = group.ids.slice(0, at).includes(id) ? at - 1 : at
        group.ids = group.ids.filter((x) => x !== id)
        group.ids.splice(Math.min(pos, group.ids.length), 0, id)
        order = items.flatMap((g) => g.ids)
      } else {
        order = placeItem(items, (g) => g.parentId === null && g.ids[0] === id, at, { parentId: key, ids: [id] }).flatMap((g) => g.ids)
      }
    } else {
      order = cell.filter((x) => x !== id)
      order.splice(Math.min(at - (cell.slice(0, at).includes(id) ? 1 : 0), order.length), 0, id)
    }
    const changed = order.join() !== cell.join() || move.status || move.parentId !== undefined || move.assigneeId !== undefined
    return changed ? { ...move, list: order } : null
  }

  // Parent columns: cards are a parent's subtasks, so position = order among siblings.
  const newParent = move.parentId !== undefined ? move.parentId : t.parentId
  const sibling = (x?: string) => !!x && x !== id && c.data.tasks[x]?.parentId === newParent
  const before = cell[at]
  const after = cell[at - 1]
  if (sibling(before)) move.place = { before }
  else if (sibling(after)) move.place = { after }
  return Object.keys(move).length > 2 ? move : null
}

/**
 * Puts `item` at position `at` among `items`, taking out the items `moving` matches first. `at` counts those items
 * (it's measured with them still in the list).
 */
function placeItem(items: CardGroup[], moving: (g: CardGroup) => boolean, at: number, item: CardGroup): CardGroup[] {
  const out = items.filter((g) => !moving(g))
  const before = items.slice(0, at).filter(moving).length
  out.splice(Math.min(at - before, out.length), 0, item)
  return out
}

/**
 * A parent's header dropped at position `at` among a list's items (cards without a header, and groups): all its
 * subtasks from the list it came from move there together, joining any of its subtasks already in that list. In its
 * own list, this re-orders the list. Null when nothing would change; BLOCKED.project when it would change project.
 */
export function dropGroupCommand(c: DropContext, g: GroupDrag, row: string, col: string, at: number): Command | typeof BLOCKED.project | null {
  const k = cellKey(row, col)
  if (c.config.rows === 'rootParent' && row !== g.row) return BLOCKED.project
  const cell = c.cells.get(k) ?? []
  const items = groupCell(c.idx, cell, row)
  // Its subtasks already in that list (or, in its own list, any not shown) go with it.
  const mine = (x: CardGroup) => x.parentId === g.parentId
  const others = items.find(mine)?.ids.filter((x) => !g.ids.includes(x)) ?? []
  const list = placeItem(items, mine, at, { parentId: g.parentId, ids: [...others, ...g.ids] }).flatMap((x) => x.ids)
  if (g.cell === k && list.join() === cell.join()) return null
  const assignee = c.config.rows === 'assignee' ? { assigneeId: row === UNASSIGNED ? null : row } : {}
  return { type: 'tasks.moveToList', ids: g.ids, status: col, list, ...assignee }
}

/** A new card typed into a cell takes that cell's status / parent / person, and lands at the bottom. */
export function newCardIn(c: DropContext, focusId: string | undefined, row: string, col: string, title: string) {
  const fields: TaskFields & { title: string } = { title }
  let parentId: string | null = focusId ?? null
  if (c.config.rows === 'directParent') parentId = row === TOP_LEVEL ? null : row
  if (c.config.rows === 'rootParent') parentId = row
  if (c.config.rows === 'assignee') fields.assigneeId = row === UNASSIGNED ? null : row
  if (statusLists(c)) fields.status = col
  else parentId = col
  return { parentId, fields, rankAfter: (c.cells.get(cellKey(row, col)) ?? []).at(-1) }
}
