import type { Change } from '@kanbanto/model/records'
import type { Board, LabelDef, Meta, StatusColumn, Task } from '@kanbanto/model/types'
import type { ColorName } from '@kanbanto/model/colors'
import { boards, labels, lists, tasks } from '../db/schema'

// Converting between database rows and the model's records. Optional fields are NULL in the database
// and left out in the model (never `undefined` values), so records compare and serialize the same everywhere.

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect']

const toMeta = (r: { createdAt: Date; updatedAt: Date; version: number }): Meta => ({
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
})
/** Timestamps from clients (restores, imports) may be anything; an unreadable one becomes "now". */
const toDate = (s: string) => {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? new Date() : d
}
const fromMeta = (m: Meta) => ({ createdAt: toDate(m.createdAt), updatedAt: toDate(m.updatedAt), version: m.version })

export const boardFromRow = (r: Row<typeof boards>): Board => ({
  id: r.id,
  name: r.name,
  mode: r.mode,
  ...(r.background ? { background: r.background as ColorName } : {}),
  ...toMeta(r),
})

export const listFromRow = (r: Row<typeof lists>): StatusColumn => ({
  id: r.id,
  name: r.name,
  category: r.category,
  ...(r.color ? { color: r.color as ColorName } : {}),
  position: r.position,
  ...toMeta(r),
})
export const listToRow = (boardId: string, c: StatusColumn): Row<typeof lists> => ({
  boardId,
  id: c.id,
  name: c.name,
  category: c.category,
  color: c.color ?? null,
  position: c.position,
  ...fromMeta(c),
})

export const labelFromRow = (r: Row<typeof labels>): LabelDef => ({
  id: r.id,
  name: r.name,
  color: r.color as ColorName,
  ...toMeta(r),
})
export const labelToRow = (boardId: string, l: LabelDef): Row<typeof labels> => ({
  boardId,
  id: l.id,
  name: l.name,
  color: l.color,
  ...fromMeta(l),
})

export function taskFromRow(r: Row<typeof tasks>): Task {
  const t: Task = {
    id: r.id,
    title: r.title,
    parentId: r.parentId,
    status: r.status,
    order: r.outlineOrder,
    labels: r.labels,
    blockedBy: r.blockedBy,
    ...toMeta(r),
  }
  if (r.description) t.description = r.description
  if (r.rank) t.rank = r.rank
  if (r.start) t.start = r.start
  if (r.due) t.due = r.due
  if (r.assigneeId) t.assigneeId = r.assigneeId
  if (r.color) t.color = r.color as ColorName
  return t
}
export const taskToRow = (boardId: string, t: Task): Row<typeof tasks> => ({
  boardId,
  id: t.id,
  parentId: t.parentId,
  title: t.title,
  description: t.description ?? null,
  status: t.status,
  outlineOrder: t.order,
  rank: t.rank ?? null,
  start: t.start ?? null,
  due: t.due ?? null,
  assigneeId: t.assigneeId ?? null,
  labels: t.labels,
  blockedBy: t.blockedBy,
  color: t.color ?? null,
  ...fromMeta(t),
})

export const boardFields = (b: Board) => ({
  name: b.name,
  mode: b.mode,
  background: b.background ?? null,
  ...fromMeta(b),
})

/** Changes that create every record of a new board (lists, labels, tasks). */
export function creations(data: { columns: StatusColumn[]; labels: LabelDef[]; tasks: Record<string, Task> }): Change[] {
  return [
    ...data.columns.map((c): Change => ({ entity: 'column', id: c.id, before: null, after: c })),
    ...data.labels.map((l): Change => ({ entity: 'label', id: l.id, before: null, after: l })),
    ...Object.values(data.tasks).map((t): Change => ({ entity: 'task', id: t.id, before: null, after: t })),
  ]
}
