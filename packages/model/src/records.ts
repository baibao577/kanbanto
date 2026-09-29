import { builtIn, type Board, type LabelDef, type Member, type Meta, type StatusColumn, type Task } from './types'

/** Every kind of stored record, by name. */
export interface Records {
  board: Board
  member: Member
  column: StatusColumn
  label: LabelDef
  task: Task
}
export type Entity = keyof Records

/**
 * One record changing: created (before = null), deleted (after = null) or edited.
 * A command produces a list of these. The same list is what gets saved, sent to other tabs,
 * reversed for undo, and (later) sent to a server.
 */
export type Change = { [K in Entity]: { entity: K; id: string; before: Records[K] | null; after: Records[K] | null } }[Entity]

/** The next version of a record: bumps `version` and `updatedAt`, keeps `createdAt`. */
export function stamp<T extends Meta>(before: T | null, next: Omit<T, keyof Meta>, now: string): T {
  return {
    ...next,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
    version: (before?.version ?? 0) + 1,
  } as T
}

/** A task with defaults filled in (for built-in data, tests and generated boards). */
export function makeTask(fields: Partial<Task> & Pick<Task, 'id' | 'title' | 'status' | 'order'>, meta: Meta = builtIn()): Task {
  return { parentId: null, labels: [], blockedBy: [], ...meta, ...fields }
}
