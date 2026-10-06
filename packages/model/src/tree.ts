import type { TaskIndex } from './indexer'

/** Top-level rows for a tree-shaped layout: the children of `rootId`, or all roots. */
export function treeTop(idx: TaskIndex, rootId?: string): { top: string[]; baseDepth: number } {
  return rootId && rootId in idx.tasks
    ? { top: idx.childrenOf.get(rootId) ?? [], baseDepth: idx.depth.get(rootId)! + 1 }
    : { top: idx.roots, baseDepth: 0 }
}

/** Small data: open two levels. Big data: start collapsed. */
export function defaultExpanded(idx: TaskIndex): Set<string> {
  return idx.preorder.length > 2000 ? new Set() : new Set(idx.preorder.filter((id) => idx.depth.get(id)! < 2))
}

/**
 * The tasks that match, plus every ancestor of a match so each one keeps its place in the tree.
 * `matched` tells the real matches apart from ancestors shown only for context.
 */
export function keepMatching(idx: TaskIndex, test: (id: string) => boolean): { keep: Set<string>; matched: Set<string> } {
  const keep = new Set<string>()
  const matched = new Set<string>()
  for (const id of idx.preorder) {
    if (!test(id)) continue
    matched.add(id)
    let cur: string | null = id
    while (cur && !keep.has(cur)) {
      keep.add(cur)
      const p: string | null = idx.tasks[cur].parentId
      cur = p && p in idx.tasks ? p : null
    }
  }
  return { keep, matched }
}

/** Search in a tree: the matching tasks plus their ancestors, so each match keeps its context. */
export const searchKeep = (idx: TaskIndex, match: (title: string) => boolean) => keepMatching(idx, (id) => match(idx.tasks[id].title)).keep

/**
 * Flattens only the expanded part of the tree, stopping at `limit` rows.
 * With `keep` (a search), only those tasks show and they're all expanded. With `folds` as well, `keep` only says
 * which tasks show ("Hide done"): what is folded stays folded.
 */
export function flattenTree(
  idx: TaskIndex,
  top: string[],
  expanded: Set<string>,
  limit: number,
  keep?: Set<string>,
  /** Sibling order (e.g. sorted by a column); outline order when omitted. */
  order?: (siblings: string[]) => string[],
  folds = false,
) {
  const rows: string[] = []
  const stack = [...(order ? order(top) : top)].reverse()
  while (stack.length && rows.length <= limit) {
    const id = stack.pop()!
    if (keep && !keep.has(id)) continue
    rows.push(id)
    const found = idx.childrenOf.get(id)
    const kids = found && order ? order(found) : found
    if (kids && ((keep && !folds) || expanded.has(id))) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

/** Row index after which to put an inline "add a subtask" field: after the parent's last visible descendant. */
export function afterSubtree(idx: TaskIndex, rows: string[], parentId: string): number {
  const at = rows.indexOf(parentId)
  if (at === -1) return -1
  const depth = idx.depth.get(parentId)!
  let i = at
  while (i + 1 < rows.length && idx.depth.get(rows[i + 1])! > depth) i++
  return i
}
