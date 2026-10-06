import { descendantsOf, isBlocked, isLeaf, type TaskIndex } from './indexer'
import { comparePositions } from './position'
import { listSort, sortComparator } from './table'
import type { FieldDef } from './fields'
import { DONE_DAYS, type Scope, type Task, type ViewConfig } from './types'

/** A column or a row. `taskId` is set when the lane stands for a task (a parent). */
export interface Lane {
  key: string
  title: string
  taskId?: string
}

export interface BoardView {
  columns: Lane[]
  rows: Lane[]
  /** Card ids per cell, keyed by `cellKey(row, column)`, in tree order. */
  cells: Map<string, string[]>
  /** Every task that passed the filter, in tree order (used by list layout). */
  ids: string[]
  /** Recent done lists: how many older cards each one leaves out (list id → count). */
  olderDone: Map<string, number>
}

export const NO_ROW = '_'
export const TOP_LEVEL = '__top'
export const UNASSIGNED = '__unassigned'

export const cellKey = (row: string, col: string) => `${row}\u0000${col}`

/**
 * A status list's cards in the order made by hand: the order they were dragged into; cards never dragged follow, in
 * outline order.
 */
export function byHand(idx: TaskIndex, ids: string[]): string[] {
  return [...ids].sort((a, b) => byRank(idx, a, b) || idx.position.get(a)! - idx.position.get(b)!)
}

const byRank = (idx: TaskIndex, a: string, b: string) => {
  const ra = idx.tasks[a].rank
  const rb = idx.tasks[b].rank
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1
  return comparePositions(ra, rb)
}

/** Compares cards the way the board reads: list by list (left to right), each list in the order made by hand. */
export function byBoard(idx: TaskIndex): (a: string, b: string) => number {
  const at = new Map(idx.columns.map((c, i) => [c.id, i]))
  return (a, b) => at.get(idx.status.get(a)!)! - at.get(idx.status.get(b)!)! || byRank(idx, a, b) || idx.position.get(a)! - idx.position.get(b)!
}

/** Whether subtasks are grouped under parent headers (only for status lists, and not when the cards are the parents). */
export const groupsSubtasks = (cfg: ViewConfig) =>
  !!cfg.groupByParent && cfg.columns === 'status' && cfg.filter !== 'topLevel' && cfg.filter !== 'main'

/** One thing a grouped list shows: a parent's group of subtasks, or (`parentId: null`) a card with no parent header. */
export interface CardGroup {
  parentId: string | null
  ids: string[]
}

/**
 * Splits a cell's cards into what a grouped list shows, keeping the list's order: each card with no parent header (top
 * level, or the row's own task) on its own, and one group per parent, placed where its first card is.
 */
export function groupCell(idx: TaskIndex, ids: string[], rowKey: string): CardGroup[] {
  const out: CardGroup[] = []
  const groups = new Map<string, CardGroup>()
  for (const id of ids) {
    const p = idx.tasks[id].parentId
    if (!p || !(p in idx.tasks) || p === rowKey) {
      out.push({ parentId: null, ids: [id] })
      continue
    }
    const g = groups.get(p)
    if (g) g.ids.push(id)
    else {
      const group = { parentId: p, ids: [id] }
      groups.set(p, group)
      out.push(group)
    }
  }
  return out
}

export const validFocus = (idx: TaskIndex, scope: Scope) => (scope.focusId && scope.focusId in idx.tasks ? scope.focusId : undefined)

/**
 * Does a card answer the search box? Its title holds what was typed, in any case, or one of its text fields does
 * (`fields`: the board's own). Null when there's no search.
 */
export function matcher(search?: string, fields?: Iterable<FieldDef>): ((t: Pick<Task, 'title' | 'custom'>) => boolean) | null {
  const q = search?.trim().toLowerCase()
  if (!q) return null
  const texts = [...(fields ?? [])].filter((f) => f.type === 'text').map((f) => f.id)
  const holds = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(q)
  return (t) => holds(t.title) || (!!t.custom && texts.some((id) => holds(t.custom![id])))
}

/** Step 1 — which tasks are visible: the focused subtree (or everything), then the filter. */
export function filterTasks(idx: TaskIndex, cfg: ViewConfig, scope: Scope = {}): string[] {
  const focus = validFocus(idx, scope)
  const base = focus ? descendantsOf(idx, focus) : idx.preorder
  switch (cfg.filter) {
    case 'all':
      return base
    case 'leaves':
      return base.filter((id) => isLeaf(idx, id))
    case 'main': {
      // One card per branch; subtasks stay on their parent's card. With a row per project (and no focus),
      // the project is the row, so its direct tasks are the cards — a project without tasks is a card itself.
      const top = focus ? (idx.childrenOf.get(focus) ?? []) : idx.roots
      if (cfg.rows !== 'rootParent' || focus) return top
      return top.flatMap((r) => idx.childrenOf.get(r) ?? [r])
    }
    case 'topLevel':
      return focus ? (idx.childrenOf.get(focus) ?? []) : idx.roots
    case 'actionable':
      return base.filter((id) => isLeaf(idx, id) && idx.category.get(id) === 'todo' && !isBlocked(idx, id))
  }
}

/**
 * The whole idea in one function: a view is filter → columns → rows → parent display.
 * Nothing here knows about React.
 */
export function buildView(idx: TaskIndex, cfg: ViewConfig, scope: Scope = {}): BoardView {
  const { tasks } = idx
  // Hidden lists take their cards with them, whatever the columns are.
  const hidden = new Set(cfg.hiddenColumns ?? [])
  const visible = (id: string) => !hidden.has(idx.status.get(id)!)
  const all = filterTasks(idx, cfg, scope)
  const filtered = hidden.size ? all.filter(visible) : all
  const match = matcher(scope.search, idx.fields.values())

  // Step 2 — columns, and which (task → column) each visible card belongs to.
  let columns: Lane[]
  let cards: { id: string; col: string }[]
  if (cfg.columns === 'status') {
    columns = idx.columns.filter((c) => !hidden.has(c.id)).map((c) => ({ key: c.id, title: c.name }))
    cards = filtered.map((id) => ({ id, col: idx.status.get(id)! }))
  } else {
    // Parent as column: the filter picks the parents; their direct children are the cards.
    // Leaves only become columns for top-level, so you can drop a first child into them.
    const parents = cfg.filter === 'topLevel' ? filtered : filtered.filter((id) => !isLeaf(idx, id))
    columns = parents.map((id) => ({ key: id, title: tasks[id].title, taskId: id }))
    cards = []
    for (const p of parents) for (const c of idx.childrenOf.get(p) ?? []) if (visible(c)) cards.push({ id: c, col: p })
    cards.sort((a, b) => idx.position.get(a.id)! - idx.position.get(b.id)!)
  }
  // Search and filters narrow the cards, never the columns, so the board keeps its shape.
  if (match) cards = cards.filter((c) => match(tasks[c.id]))
  if (scope.keep) cards = cards.filter((c) => scope.keep!(c.id))

  // Step 3 — rows.
  const rowOf = (id: string): string => {
    switch (cfg.rows) {
      case 'none':
        return NO_ROW
      case 'rootParent':
        return idx.rootOf.get(id)!
      case 'directParent': {
        const p = tasks[id].parentId
        return p && p in tasks ? p : TOP_LEVEL
      }
      case 'assignee':
        return tasks[id].assigneeId || UNASSIGNED
    }
  }

  // Step 4 — parent display "row header": a task that is already a row header isn't also a card.
  // Grouping turns parents into headers inside lists, so only tasks without subtasks stay cards.
  if (groupsSubtasks(cfg)) cards = cards.filter((c) => isLeaf(idx, c.id))

  // Recent done lists leave out cards with no activity for a while (see ViewConfig.doneLists), counting them.
  const olderDone = new Map<string, number>()
  if (cfg.columns === 'status' && (cfg.doneLists ?? 'recent') === 'recent' && scope.now !== undefined) {
    const since = scope.now - (cfg.doneDays ?? DONE_DAYS) * 86_400_000
    cards = cards.filter(({ id, col }) => {
      if (idx.colById.get(col)?.category !== 'done' || scope.showOlder?.has(col) || idx.lastActive.get(id)! >= since) return true
      olderDone.set(col, (olderDone.get(col) ?? 0) + 1)
      return false
    })
  }
  const rowKeys = new Set(cards.map((c) => rowOf(c.id)))
  const hideRowHeaders = cfg.parentDisplay.includes('rowHeader') && cfg.rows !== 'none' && cfg.rows !== 'assignee'

  const cells = new Map<string, string[]>()
  // A board with no row grouping always has its one lane, even when empty, so there's somewhere to drop.
  const usedRows = new Set<string>(cfg.rows === 'none' ? [NO_ROW] : [])
  for (const { id, col } of cards) {
    if (hideRowHeaders && rowKeys.has(id)) continue
    const row = rowOf(id)
    usedRows.add(row)
    const k = cellKey(row, col)
    const list = cells.get(k)
    if (list) list.push(id)
    else cells.set(k, [id])
  }

  // Status lists keep the order you dragged cards into, unless the list is shown in another order (ties keep it).
  if (cfg.columns === 'status') {
    for (const [k, list] of cells) {
      const sorted = byHand(idx, list)
      const by = cfg.listOrder?.[idx.status.get(list[0])!]
      cells.set(k, by ? [...sorted].sort(sortComparator(idx, listSort(by), new Map())) : sorted)
    }
  }

  // Rows per parent task are nested, so every row needs its parent's row above it, even when that
  // parent has no cards of its own to show (e.g. its only subtask is itself a row). Stop at the focused task.
  if (cfg.rows === 'directParent') {
    const focus = validFocus(idx, scope)
    for (const key of [...usedRows]) {
      if (!(key in tasks) || key === focus) continue
      let p = tasks[key].parentId
      while (p && p in tasks && !usedRows.has(p)) {
        usedRows.add(p)
        if (p === focus) break
        p = tasks[p].parentId
      }
    }
  }

  const rows = [...usedRows].map((key): Lane => {
    if (key === NO_ROW) return { key, title: '' }
    if (key === TOP_LEVEL) return { key, title: 'Projects' }
    if (key === UNASSIGNED) return { key, title: 'No one assigned' }
    if (cfg.rows === 'assignee') return { key, title: idx.members.get(key)?.name ?? 'Unknown' }
    return { key, title: tasks[key].title, taskId: key }
  })
  rows.sort((a, b) => laneRank(idx, a, cfg) - laneRank(idx, b, cfg) || a.title.localeCompare(b.title))

  return { columns, rows, cells, ids: match ? filtered.filter((id) => match(tasks[id])) : filtered, olderDone }
}

function laneRank(idx: TaskIndex, lane: Lane, cfg: ViewConfig): number {
  if (lane.key === TOP_LEVEL) return -1
  if (lane.key === UNASSIGNED) return Number.MAX_SAFE_INTEGER
  if (cfg.rows === 'assignee') return 0
  return lane.taskId ? idx.position.get(lane.taskId)! : 0
}
