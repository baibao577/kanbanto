import { execute } from './commands'
import { descendantsOf, indexFor } from './indexer'
import { positionBetween } from './position'
import type { Change } from './records'
import type { BoardData, LabelDef, Task } from './types'

/** Where a task lands on the other board. */
export interface MoveTarget {
  /** A list on the other board for everything that isn't done yet. Omit: lists with the same name, else the same kind. */
  status?: string
  /** A task on the other board to put it under. Omit: the top level. */
  parentId?: string | null
}

export interface MovePlan {
  /** What changes on the board it leaves (the task and its subtasks go; links to them are dropped). */
  source: Change[]
  /** What changes on the board it goes to (new labels, then the tasks, under new ids). */
  target: Change[]
  /** Old id → new id, for every task that moves. */
  ids: Map<string, string>
  /** What people should know before moving it. */
  summary: {
    title: string
    subtasks: number
    /** People it was assigned to who aren't on the other board (those tasks are unassigned). */
    unassigned: string[]
    /** Labels the other board didn't have, added to it. */
    newLabels: string[]
    /** "Waiting on" links to tasks that stay behind (dropped). */
    droppedLinks: number
  }
}

/**
 * Moving a task (with its subtasks) to another board: they're deleted here and created there under new ids (ids are
 * only unique within a board). Lists are matched by name, then by kind; labels by name (missing ones are added);
 * people only if they're on that board too; "waiting on" links only between tasks that move together.
 */
export function planMove(
  source: BoardData,
  target: BoardData,
  taskId: string,
  to: MoveTarget,
  ctx: { now: string; newId: () => string },
): MovePlan | { error: string } {
  const root = source.tasks[taskId]
  if (!root) return { error: 'That task no longer exists.' }
  if (source.board.id === target.board.id) return { error: 'It’s already on this board.' }
  if (to.parentId && !target.tasks[to.parentId]) return { error: 'That parent task isn’t on the other board.' }
  if (to.status && !target.columns.some((c) => c.id === to.status)) return { error: 'That list isn’t on the other board.' }

  const sIdx = indexFor(source)
  const tIdx = indexFor(target)
  const moving = [taskId, ...descendantsOf(sIdx, taskId)]
  const inMove = new Set(moving)
  const removed = execute(source, { type: 'task.delete', id: taskId }, { now: ctx.now, newId: ctx.newId, idx: sIdx })
  if ('error' in removed) return removed

  const ids = new Map(moving.map((id) => [id, ctx.newId()]))
  const lower = (s: string) => s.trim().toLowerCase()

  // Lists: the one asked for (except for what's done), else the same name, else the first of the same kind.
  const firstDone = tIdx.firstOf.done
  const listFor = (t: Task) => {
    const from = source.columns.find((c) => c.id === t.status)
    if (to.status) return from?.category === 'done' ? firstDone : to.status
    const same = from && target.columns.find((c) => lower(c.name) === lower(from.name))
    return same?.id ?? (from ? tIdx.firstOf[from.category] : tIdx.firstOf.todo)
  }

  // Labels: the same name (or, unnamed, the same color), else added.
  const target_: Change[] = []
  const labelIds = new Map<string, string>()
  const newLabels: string[] = []
  const known = [...target.labels]
  for (const id of new Set(moving.flatMap((m) => source.tasks[m].labels))) {
    const l = source.labels.find((x) => x.id === id)
    if (!l) continue
    const match = known.find((x) => (l.name.trim() ? lower(x.name) === lower(l.name) : !x.name.trim() && x.color === l.color))
    if (match) {
      labelIds.set(id, match.id)
      continue
    }
    const made: LabelDef = { id: ctx.newId(), name: l.name, color: l.color, createdAt: ctx.now, updatedAt: ctx.now, version: 1 }
    known.push(made)
    labelIds.set(id, made.id)
    newLabels.push(l.name || l.color)
    target_.push({ entity: 'label', id: made.id, before: null, after: made })
  }

  const onTarget = new Set(target.members.map((m) => m.id))
  const unassigned = new Set<string>()
  let droppedLinks = 0
  const parent = to.parentId ?? null
  const lastSibling = (parent ? tIdx.childrenOf.get(parent) : tIdx.roots)?.at(-1)
  for (const id of moving) {
    const t = source.tasks[id]
    const { rank: _rank, assigneeId, ...rest } = t
    const keep = assigneeId && onTarget.has(assigneeId)
    if (assigneeId && !keep) unassigned.add(source.members.find((m) => m.id === assigneeId)?.name ?? 'Someone')
    droppedLinks += t.blockedBy.filter((b) => !inMove.has(b)).length
    const next: Task = {
      ...rest,
      id: ids.get(id)!,
      parentId: id === taskId ? parent : ids.get(t.parentId!)!,
      // Its place among its new siblings (at the end); subtasks keep theirs.
      order: id === taskId ? positionBetween(lastSibling ? target.tasks[lastSibling].order : null, null) : t.order,
      status: listFor(t),
      labels: t.labels.flatMap((l) => (labelIds.has(l) ? [labelIds.get(l)!] : [])),
      blockedBy: t.blockedBy.filter((b) => inMove.has(b)).map((b) => ids.get(b)!),
      ...(keep && { assigneeId }),
      // Reminders go too; who set one is kept only if they're on the other board.
      ...(t.reminders && {
        reminders: t.reminders.map(({ by, ...r }) => ({ ...r, ...(by && onTarget.has(by) && { by }) })),
      }),
      updatedAt: ctx.now,
      version: 1,
    }
    target_.push({ entity: 'task', id: next.id, before: null, after: next })
  }

  return {
    source: removed.changes,
    target: target_,
    ids,
    summary: { title: root.title, subtasks: moving.length - 1, unassigned: [...unassigned], newLabels, droppedLinks },
  }
}
