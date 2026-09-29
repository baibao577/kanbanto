import type { ColorName } from '@kanbanto/model/colors'
import { newId } from '@kanbanto/model/ids'
import { emptyBoard, exampleData } from '@kanbanto/model/sample'
import type { BoardData, Meta } from '@kanbanto/model/types'
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

/** Saves a new board with `ownerId` as its owner. */
export async function insertBoard(tx: Tx, data: BoardData, ownerId: string, visibility: Visibility = 'invited') {
  const now = new Date()
  await tx.insert(boards).values({
    id: data.board.id,
    name: data.board.name,
    mode: data.board.mode,
    background: data.board.background ?? null,
    visibility,
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now,
    version: data.board.version,
  })
  await tx.insert(boardMembers).values({ boardId: data.board.id, userId: ownerId, role: 'owner', createdAt: now, updatedAt: now, version: 1 })
  await writeChanges(tx, data.board.id, creations(data))
}

export type Template = 'empty' | 'example'

export async function createBoard(db: Db, ownerId: string, opts: { name: string; background?: ColorName; template: Template }): Promise<string> {
  const id = newId()
  const now = new Date().toISOString()
  const base = opts.template === 'example' ? freshMeta(exampleData(id, ownerId), now) : emptyBoard(id, opts.name, now)
  const data: BoardData = {
    ...base,
    board: { ...base.board, name: opts.name, ...(opts.background ? { background: opts.background } : {}) },
  }
  await db.transaction((tx) => insertBoard(tx, data, ownerId))
  return id
}

/**
 * Saves an imported board as a new board. Its people aren't accounts here, so assignments are dropped
 * (except to the person importing, if the file came from their own export).
 */
export async function importBoard(db: Db, ownerId: string, data: BoardData): Promise<string> {
  const id = newId()
  const tasks = Object.fromEntries(
    Object.values(data.tasks).map((t) => {
      const { assigneeId, ...rest } = t
      return [t.id, assigneeId === ownerId ? t : rest]
    }),
  )
  await db.transaction((tx) => insertBoard(tx, { ...data, board: { ...data.board, id }, members: [], tasks }, ownerId))
  return id
}
