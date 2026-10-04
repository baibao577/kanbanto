import type { BoardBackground } from '@kanbanto/model/colors'
import { newId } from '@kanbanto/model/ids'
import { emptyBoard, exampleData } from '@kanbanto/model/sample'
import type { BoardData, Meta, Task } from '@kanbanto/model/types'
import type { Db, Tx } from '../db'
import { boardMembers, boards, type Visibility } from '../db/schema'
import { creations } from './records'
import { writeChanges } from './store'

/** Every record stamped as new: version 1, created now (templates are built from fixed sample data). */
function freshMeta(data: BoardData, now: string): BoardData {
  const m = <T extends Meta>(r: T): T => ({ ...r, createdAt: now, updatedAt: now, version: 1 })
  return {
    board: m(data.board),
    members: [],
    columns: data.columns.map(m),
    labels: data.labels.map(m),
    tasks: Object.fromEntries(Object.entries(data.tasks).map(([id, t]) => [id, m(t)])),
  }
}

/** Saves a new board with `ownerId` as its owner: in a workspace (shared with everyone in it), or in Personal. */
export async function insertBoard(tx: Tx, data: BoardData, ownerId: string, workspaceId: string | null = null) {
  const now = new Date()
  const visibility: Visibility = workspaceId ? 'workspace' : 'invited'
  await tx.insert(boards).values({
    id: data.board.id,
    name: data.board.name,
    mode: data.board.mode,
    background: data.board.background ?? null,
    description: data.board.description ?? null,
    visibility,
    workspaceId,
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now,
    version: data.board.version,
  })
  await tx.insert(boardMembers).values({ boardId: data.board.id, userId: ownerId, role: 'owner', createdAt: now, updatedAt: now, version: 1 })
  // Cards that arrive finished (the example board, an imported one) were done by their last change, as far as we know.
  const doneLists = new Set(data.columns.filter((c) => c.category === 'done').map((c) => c.id))
  const tasks = Object.fromEntries(
    Object.values(data.tasks).map((t) => [t.id, doneLists.has(t.status) && !t.doneAt ? { ...t, doneAt: t.activeAt ?? t.updatedAt } : t]),
  )
  await writeChanges(tx, data.board.id, creations({ ...data, tasks }))
}

export type Template = 'empty' | 'example'

export async function createBoard(
  db: Db,
  ownerId: string,
  opts: { name: string; background?: BoardBackground; template: Template; workspaceId?: string | null; description?: string },
): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  const base = opts.template === 'example' ? freshMeta(exampleData(id, ownerId), now) : emptyBoard(id, opts.name, now)
  const data: BoardData = {
    ...base,
    board: {
      ...base.board,
      name: opts.name,
      ...(opts.background ? { background: opts.background } : {}),
      ...(opts.description?.trim() ? { description: opts.description.trim() } : {}),
    },
  }
  await db.transaction((tx) => insertBoard(tx, data, ownerId, opts.workspaceId ?? null))
  return id
}

/**
 * Saves an imported board as a new board. Its people aren't accounts here, so assignments are dropped
 * (except to the person importing, if the file came from their own export).
 */
export async function importBoard(db: Db, ownerId: string, data: BoardData): Promise<string> {
  const id = newId()
  // (The same goes for who set a reminder, which is who it goes to on an unassigned card: the importer now.)
  const mine = (t: Task): Task => {
    const { assigneeId, ...rest } = t
    const kept = assigneeId === ownerId ? t : rest
    return kept.reminders?.some((r) => r.by && r.by !== ownerId)
      ? { ...kept, reminders: kept.reminders.map((r) => (r.by ? { ...r, by: ownerId } : r)) }
      : kept
  }
  const all = (tasks: Record<string, Task>) => Object.fromEntries(Object.values(tasks).map((t) => [t.id, mine(t)]))
  const tasks = all(data.tasks)
  const archived = data.archived && all(data.archived)
  await db.transaction((tx) =>
    insertBoard(tx, { ...data, board: { ...data.board, id }, members: [], tasks, ...(archived ? { archived } : {}) }, ownerId),
  )
  return id
}
