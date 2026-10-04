import type { Task, TaskMap } from './types'

/**
 * Archived tasks, asked for apart from the board (the app is sent a board without them): one with what was put away
 * around it, or the ones with a date in a stretch of time.
 */

/** Which of an archived task's dates a range is about. `any`: whichever of them falls in it. */
export const ARCHIVED_DATES = ['archived', 'done', 'created', 'any'] as const
export type ArchivedDate = (typeof ARCHIVED_DATES)[number]

/** When an archived task got done (ms). Only one archived as completed has such a moment. */
export const archivedDoneAt = (t: Task): number | null => (t.archivedDone && t.archivedAt ? Date.parse(t.doneAt ?? t.archivedAt) : null)

/**
 * An archived task with its family: the archived tasks above it (top first), itself, and every archived task under
 * it. Enough to show it as it was, and to restore it. Empty when there's no such archived task.
 */
export function archivedFamily(archived: TaskMap, id: string): Task[] {
  const t = archived[id]
  if (!t) return []
  const above: Task[] = []
  const seen = new Set([id])
  for (let p = t.parentId; p && archived[p] && !seen.has(p); p = archived[p].parentId) {
    above.unshift(archived[p])
    seen.add(p)
  }
  const kids = new Map<string, string[]>()
  for (const a of Object.values(archived)) {
    if (!a.parentId) continue
    const list = kids.get(a.parentId)
    if (list) list.push(a.id)
    else kids.set(a.parentId, [a.id])
  }
  const under: Task[] = []
  const stack = [...(kids.get(id) ?? [])]
  while (stack.length) {
    const c = stack.pop()!
    if (seen.has(c)) continue
    seen.add(c)
    under.push(archived[c])
    stack.push(...(kids.get(c) ?? []))
  }
  return [...above, t, ...under]
}

/**
 * The archived tasks with a date in the range (`from` up to, not including, `to`; ms), newest first by that date.
 * `when` says which date: archived (the default), done, created, or any of the three (then the latest one in the range
 * counts). Without a range: all of them.
 */
export function archivedIn(archived: TaskMap, q: { when?: ArchivedDate; from?: number; to?: number }): Task[] {
  const within = (ms: number | null): ms is number => ms !== null && !Number.isNaN(ms) && ms >= (q.from ?? -Infinity) && ms < (q.to ?? Infinity)
  const dateOf = (t: Task): number | null => {
    const dates = { archived: t.archivedAt ? Date.parse(t.archivedAt) : null, done: archivedDoneAt(t), created: Date.parse(t.createdAt) }
    if (q.when && q.when !== 'any') return within(dates[q.when]) ? dates[q.when] : null
    if (!q.when) return within(dates.archived) ? dates.archived : null
    const hits = Object.values(dates).filter(within)
    return hits.length ? Math.max(...hits) : null
  }
  const found: { t: Task; at: number }[] = []
  for (const t of Object.values(archived)) {
    const at = dateOf(t)
    if (at !== null) found.push({ t, at })
  }
  // (The id breaks ties, so pages never overlap.)
  return found.sort((a, b) => b.at - a.at || (a.t.id < b.t.id ? -1 : 1)).map((f) => f.t)
}
