import { comparePositions } from '@kanbanto/model/position'
import type { Change } from '@kanbanto/model/records'
import type { BoardData, Member } from '@kanbanto/model/types'
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { Db, Tx } from '../db'
import { boardMembers, boards, labels, lists, tasks, users, workspaceMembers, type Role } from '../db/schema'
import { higherRole, type BoardRow } from './access'
import { boardFields, boardFromRow, labelFromRow, labelToRow, listFromRow, listToRow, taskFromRow, taskToRow } from './records'

export interface Person {
  userId: string
  name: string
  email: string
  role: Role
  /** Added to the board, or there through its workspace. */
  via: 'member' | 'workspace'
  createdAt: Date
  updatedAt: Date
  version: number
}

/**
 * A board's people, the ones who can be assigned and @mentioned: those added to it, and, while it's shared with its
 * workspace, everyone in the workspace (with the board's workspace role, or their own if that's higher).
 */
export async function boardPeople(tx: Db | Tx, board: BoardRow): Promise<Person[]> {
  const added = await tx
    .select({ m: boardMembers, name: users.name, email: users.email })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(eq(boardMembers.boardId, board.id))
  const people = new Map<string, Person>(added.map(({ m, name, email }) => [m.userId, { ...m, name, email, via: 'member' as const }]))
  if (board.visibility === 'workspace' && board.workspaceId) {
    const everyone = await tx
      .select({ m: workspaceMembers, name: users.name, email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, board.workspaceId))
    for (const { m, name, email } of everyone) {
      const p = people.get(m.userId)
      if (p) p.role = higherRole(p.role, board.workspaceRole)
      else people.set(m.userId, { ...m, role: board.workspaceRole, name, email, via: 'workspace' })
    }
  }
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** A board's people, as the model sees them. */
export async function loadMembers(tx: Db | Tx, board: BoardRow): Promise<Member[]> {
  return (await boardPeople(tx, board)).map((p) => ({
    id: p.userId,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    version: p.version,
  }))
}

/** The whole board as the model sees it, plus its change counter. Null if there's no such board. */
export async function loadBoard(tx: Tx, boardId: string): Promise<{ data: BoardData; seq: number } | null> {
  const [b] = await tx.select().from(boards).where(eq(boards.id, boardId))
  if (!b) return null
  const listRows = await tx.select().from(lists).where(eq(lists.boardId, boardId))
  const labelRows = await tx.select().from(labels).where(eq(labels.boardId, boardId))
  const taskRows = await tx.select().from(tasks).where(eq(tasks.boardId, boardId))
  const members = await loadMembers(tx, b)
  return {
    seq: b.seq,
    data: {
      board: boardFromRow(b),
      members,
      columns: listRows.map(listFromRow).sort((x, y) => comparePositions(x.position, y.position)),
      labels: labelRows.map(labelFromRow),
      tasks: Object.fromEntries(taskRows.flatMap((r) => (r.archivedAt ? [] : [[r.id, taskFromRow(r)]]))),
      archived: Object.fromEntries(taskRows.flatMap((r) => (r.archivedAt ? [[r.id, taskFromRow(r)]] : []))),
    },
  }
}

/** `SET col = excluded.col` for every column except the key, for upserts. */
function excludedSet(table: PgTable, keys: string[]) {
  const set: Record<string, unknown> = {}
  for (const [prop, col] of Object.entries(getTableColumns(table))) if (!keys.includes(prop)) set[prop] = sql.raw(`excluded."${col.name}"`)
  return set
}

const CHUNK = 500
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

/** Saves the changes a command made. Upserts for created/edited records, deletes for removed ones. */
export async function writeChanges(tx: Tx, boardId: string, changes: Change[]) {
  // One write per record: if a record appears twice, its last state wins.
  const last = new Map<string, Change>()
  for (const c of changes) last.set(`${c.entity}:${c.id}`, c)

  const by = { column: [] as Change[], label: [] as Change[], task: [] as Change[] }
  for (const c of last.values()) {
    if (c.entity === 'board') {
      if (c.after) await tx.update(boards).set(boardFields(c.after)).where(eq(boards.id, boardId))
    } else if (c.entity !== 'member') by[c.entity].push(c)
  }

  const save = async <T>(table: typeof lists | typeof labels | typeof tasks, cs: Change[], toRow: (r: T) => object) => {
    const gone = cs.filter((c) => !c.after).map((c) => c.id)
    for (const ids of chunks(gone)) await tx.delete(table).where(and(eq(table.boardId, boardId), inArray(table.id, ids)))
    const rows = cs.filter((c) => c.after).map((c) => toRow(c.after as T))
    for (const part of chunks(rows))
      await tx
        .insert(table)
        .values(part as never)
        .onConflictDoUpdate({ target: [table.boardId, table.id], set: excludedSet(table, ['boardId', 'id']) })
  }
  await save(lists, by.column, (c: Parameters<typeof listToRow>[1]) => listToRow(boardId, c))
  await save(labels, by.label, (l: Parameters<typeof labelToRow>[1]) => labelToRow(boardId, l))
  await save(tasks, by.task, (t: Parameters<typeof taskToRow>[1]) => taskToRow(boardId, t))
}
