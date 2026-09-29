import { comparePositions } from './position'
import type { Change, Entity, Records } from './records'
import type { BoardData, TaskMap } from './types'

/** Applies a list of changes to board data, copying only what changed. */
export function applyChanges(data: BoardData, changes: Change[]): BoardData {
  if (!changes.length) return data
  let { board, members, columns, labels, tasks } = data
  let tasksCopied = false
  const lists: Partial<Record<Exclude<Entity, 'board' | 'task'>, Map<string, unknown>>> = {}
  const listOf = <K extends 'member' | 'column' | 'label'>(entity: K, current: Records[K][]) =>
    (lists[entity] ??= new Map(current.map((r) => [r.id, r]))) as Map<string, Records[K]>

  for (const c of changes) {
    switch (c.entity) {
      case 'board':
        if (c.after) board = c.after
        break
      case 'task':
        if (!tasksCopied) {
          tasks = { ...tasks }
          tasksCopied = true
        }
        if (c.after) tasks[c.id] = c.after
        else delete (tasks as TaskMap)[c.id]
        break
      case 'member':
        if (c.after) listOf('member', members).set(c.id, c.after)
        else listOf('member', members).delete(c.id)
        break
      case 'column':
        if (c.after) listOf('column', columns).set(c.id, c.after)
        else listOf('column', columns).delete(c.id)
        break
      case 'label':
        if (c.after) listOf('label', labels).set(c.id, c.after)
        else listOf('label', labels).delete(c.id)
        break
    }
  }
  if (lists.member) members = [...(lists.member.values() as Iterable<Records['member']>)]
  if (lists.label) labels = [...(lists.label.values() as Iterable<Records['label']>)]
  if (lists.column) columns = [...(lists.column.values() as Iterable<Records['column']>)].sort((a, b) => comparePositions(a.position, b.position))
  return { board, members, columns, labels, tasks }
}

/** The record a change is about, as it is now in `data` (null if it doesn't exist). */
export function current(data: BoardData, entity: Entity, id: string): Records[Entity] | null {
  switch (entity) {
    case 'board':
      return data.board.id === id ? data.board : null
    case 'task':
      return data.tasks[id] ?? null
    case 'member':
      return data.members.find((m) => m.id === id) ?? null
    case 'column':
      return data.columns.find((c) => c.id === id) ?? null
    case 'label':
      return data.labels.find((l) => l.id === id) ?? null
  }
}

/**
 * The changes that undo `changes`, given the data as it is now. Restored records get a new version,
 * because restoring is itself a change (a server sees it as a normal edit).
 */
export function invertChanges(data: BoardData, changes: Change[], now: string): Change[] {
  return [...changes].reverse().map((c) => {
    const now_ = current(data, c.entity, c.id)
    const after = c.before ? { ...c.before, version: (now_?.version ?? c.before.version) + 1, updatedAt: now } : null
    return { entity: c.entity, id: c.id, before: now_, after } as Change
  })
}
