import { comparePositions } from './position'
import { CATEGORIES, DEFAULT_COLUMNS, type BoardData, type Category, type Member, type StatusColumn, type StatusMode, type TaskMap } from './types'

/**
 * Everything derived from the flat task list in one O(n) pass.
 * Views never walk the tree themselves; they read from here.
 */
export interface TaskIndex {
  tasks: TaskMap
  mode: StatusMode
  /** Board members by id (for names). */
  members: Map<string, Member>
  /** The status columns, in board order. */
  columns: StatusColumn[]
  colById: Map<string, StatusColumn>
  /** First column of each category: where a derived parent lands when its children are mixed. */
  firstOf: Record<Category, string>
  /** Top-level task ids, sorted by `order`. */
  roots: string[]
  /** Direct children per task id, sorted by `order`. Missing key = leaf. */
  childrenOf: Map<string, string[]>
  /** Depth-first pre-order of the whole forest (tree reading order). */
  preorder: string[]
  /** Position of each id in `preorder`, for cheap stable sorting. */
  position: Map<string, number>
  depth: Map<string, number>
  rootOf: Map<string, string>
  /** Column id each task shows in: own status (manual) or rolled up from children (derived). */
  status: Map<string, string>
  /** Category of that column. */
  category: Map<string, Category>
  /** Every task below this one — containers count as tasks too (a leaf has 0). */
  subTotal: Map<string, number>
  /** How many of those are done (by effective status). */
  subDone: Map<string, number>
}

// Siblings by outline position; the id breaks ties so the order is always the same.
const byOrder = (tasks: TaskMap) => (a: string, b: string) => comparePositions(tasks[a].order, tasks[b].order) || comparePositions(a, b)

export function buildIndex(tasks: TaskMap, mode: StatusMode, columns: StatusColumn[] = DEFAULT_COLUMNS, memberList: Member[] = []): TaskIndex {
  const members = new Map(memberList.map((m) => [m.id, m]))
  const colById = new Map(columns.map((c) => [c.id, c]))
  const firstOf = {} as Record<Category, string>
  for (const c of columns) firstOf[c.category] ??= c.id
  const present = new Set(columns.map((c) => c.category))
  // Lists can be any mix of kinds. When a kind is missing, use the nearest earlier kind (a half-done parent
  // with no "in progress" list goes to "not started"), else the nearest later one.
  CATEGORIES.forEach((cat, i) => {
    if (firstOf[cat]) return
    const earlier = CATEGORIES.slice(0, i)
      .reverse()
      .find((c) => present.has(c))
    const later = CATEGORIES.slice(i + 1).find((c) => present.has(c))
    firstOf[cat] = firstOf[(earlier ?? later)!] ?? columns[0].id
  })
  // Tasks pointing at a deleted/unknown column fall back to the first "not started" list.
  const ownColumn = (id: string) => (colById.has(tasks[id].status) ? tasks[id].status : firstOf.todo)

  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []

  for (const id in tasks) {
    const p = tasks[id].parentId
    // A parent that no longer exists makes the task top-level.
    if (p === null || !(p in tasks)) roots.push(id)
    else {
      const list = childrenOf.get(p)
      if (list) list.push(id)
      else childrenOf.set(p, [id])
    }
  }
  const cmp = byOrder(tasks)
  roots.sort(cmp)
  for (const list of childrenOf.values()) list.sort(cmp)

  // Iterative DFS pre-order (no recursion, so deep trees can't blow the stack).
  const preorder: string[] = []
  const depth = new Map<string, number>()
  const rootOf = new Map<string, string>()
  const walk = (start: string) => {
    const stack: string[] = [start]
    depth.set(start, 0)
    rootOf.set(start, start)
    while (stack.length) {
      const id = stack.pop()!
      preorder.push(id)
      const kids = childrenOf.get(id)
      if (!kids) continue
      const d = depth.get(id)! + 1
      const r = rootOf.get(id)!
      for (let i = kids.length - 1; i >= 0; i--) {
        if (depth.has(kids[i])) continue // only reachable through a cycle
        depth.set(kids[i], d)
        rootOf.set(kids[i], r)
        stack.push(kids[i])
      }
    }
  }
  for (const r of roots) walk(r)
  // Tasks caught in a parent cycle are unreachable from any root; surface them as roots.
  if (preorder.length < Object.keys(tasks).length) {
    for (const id in tasks) {
      if (!depth.has(id)) {
        roots.push(id)
        walk(id)
      }
    }
  }

  const position = new Map<string, number>()
  preorder.forEach((id, i) => position.set(id, i))

  // Reverse pre-order visits every child before its parent → bottom-up roll-up.
  const status = new Map<string, string>()
  const category = new Map<string, Category>()
  const subTotal = new Map<string, number>()
  const subDone = new Map<string, number>()
  const set = (id: string, col: string) => {
    status.set(id, col)
    category.set(id, colById.get(col)!.category)
  }
  for (let i = preorder.length - 1; i >= 0; i--) {
    const id = preorder[i]
    const kids = childrenOf.get(id)
    if (!kids) {
      set(id, ownColumn(id))
      subTotal.set(id, 0)
      subDone.set(id, 0)
      continue
    }
    let total = 0
    let done = 0
    let allDone = true
    let anyStarted = false
    let anyReady = false
    let sameCol: string | null | undefined // undefined = none seen yet, null = children differ
    for (const k of kids) {
      const kc = category.get(k)
      if (!kc) continue // back-edge of a cycle
      total += 1 + subTotal.get(k)!
      done += (kc === 'done' ? 1 : 0) + subDone.get(k)!
      if (kc !== 'done') allDone = false
      if (kc === 'doing' || kc === 'done') anyStarted = true
      if (kc === 'todo') anyReady = true
      const ks = status.get(k)!
      sameCol = sameCol === undefined || sameCol === ks ? ks : null
    }
    subTotal.set(id, total)
    subDone.set(id, done)
    if (mode === 'manual') set(id, ownColumn(id))
    // Derived: all children in one column → parent goes there too; otherwise roll up by category.
    else if (sameCol) set(id, sameCol)
    else set(id, firstOf[allDone ? 'done' : anyStarted ? 'doing' : anyReady ? 'todo' : 'backlog'])
  }

  return {
    tasks,
    mode,
    members,
    columns,
    colById,
    firstOf,
    roots,
    childrenOf,
    preorder,
    position,
    depth,
    rootOf,
    status,
    category,
    subTotal,
    subDone,
  }
}

export const isLeaf = (idx: TaskIndex, id: string) => !idx.childrenOf.has(id)

/** The column a task currently shows in. */
export const statusCol = (idx: TaskIndex, id: string) => idx.colById.get(idx.status.get(id)!)!

export function isBlocked(idx: TaskIndex, id: string): boolean {
  for (const b of idx.tasks[id].blockedBy) {
    if (b in idx.tasks && idx.category.get(b) !== 'done') return true
  }
  return false
}

/** Ancestors from the top down, not including the task itself. */
export function ancestorsOf(tasks: TaskMap, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let p = tasks[id]?.parentId
  while (p && p in tasks && !seen.has(p)) {
    out.push(p)
    seen.add(p)
    p = tasks[p].parentId
  }
  return out.reverse()
}

/** True if making `newParentId` the parent of `id` would create a cycle. */
export function wouldCycle(tasks: TaskMap, id: string, newParentId: string | null): boolean {
  if (newParentId === null) return false
  if (newParentId === id) return true
  return ancestorsOf(tasks, newParentId).includes(id)
}

/** All descendants of `id`, in tree order. */
export function descendantsOf(idx: TaskIndex, id: string): string[] {
  const out: string[] = []
  const stack = [...(idx.childrenOf.get(id) ?? [])].reverse()
  while (stack.length) {
    const c = stack.pop()!
    out.push(c)
    const kids = idx.childrenOf.get(c)
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return out
}

const indexes = new WeakMap<BoardData, TaskIndex>()

/** The index for a board, built once per version of the data (commands and views share it). */
export function indexFor(data: BoardData): TaskIndex {
  let idx = indexes.get(data)
  if (!idx) {
    idx = buildIndex(data.tasks, data.board.mode, data.columns, data.members)
    indexes.set(data, idx)
  }
  return idx
}
