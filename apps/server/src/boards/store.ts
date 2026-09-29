import { comparePositions } from '@kanbanto/model/position'
import type { Change } from '@kanbanto/model/records'
import type { BoardData, Member } from '@kanbanto/model/types'
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { Tx } from '../db'
import { boardMembers, boards, labels, lists, tasks, users } from '../db/schema'
import { boardFields, boardFromRow, labelFromRow, labelToRow, listFromRow, listToRow, taskFromRow, taskToRow } from './records'

/** A board's people: its members, with the names from their accounts. */
export async function loadMembers(tx: Tx, boardId: string): Promise<Member[]> {
  const rows = await tx
    .select({ m: boardMembers, name: users.name })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(eq(boardMembers.boardId, boardId))
  return rows
    .map(({ m, name }) => ({
      id: m.userId,
      name,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      version: m.version,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The whole board as the model sees it, plus its change counter. Null if there's no such board. */
export async function loadBoard(tx: Tx, boardId: string): Promise<{ data: BoardData; seq: number } | null> {
  const [b] = await tx.select().from(boards).where(eq(boards.id, boardId))
  if (!b) return null
  const listRows = await tx.select().from(lists).where(eq(lists.boardId, boardId))
  const labelRows = await tx.select().from(labels).where(eq(labels.boardId, boardId))
  const taskRows = await tx.select().from(tasks).where(eq(tasks.boardId, boardId))
  const members = await loadMembers(tx, boardId)
  return {
    seq: b.seq,
    data: {
      board: boardFromRow(b),
      members,
      columns: listRows.map(listFromRow).sort((x, y) => comparePositions(x.position, y.position)),
      labels: labelRows.map(labelFromRow),
      tasks: Object.fromEntries(taskRows.map((r) => [r.id, taskFromRow(r)])),
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
