import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Tx } from '../db'
import { boardFieldRows, boards, libraryFields, tasks } from '../db/schema'
import type { BoardEngine } from './engine'
import { boardPeople } from './store'

/**
 * Someone may have stopped being one of these boards' people (taken off a board, out of its workspace). On the
 * boards where they're really gone (not still there another way: added to it, or through its workspace), their
 * cards are unassigned and they're taken out of the board's person fields, hidden ones too.
 *
 * Inside `tx`, after the change to who is on the boards. Each board is locked and its change counter raised first
 * (`engine.bump`): a command that was running finishes before this, and the next one loads the board afresh, so
 * nothing can write the person back from a copy made before they left. Returns the boards they're gone from.
 */
export async function clearPerson(engine: BoardEngine, tx: Tx, boardIds: string[], userId: string): Promise<string[]> {
  if (!boardIds.length) return []
  await engine.bump(tx, boardIds)
  const rows = await tx.select().from(boards).where(inArray(boards.id, boardIds))
  const gone: string[] = []
  for (const board of rows) if (!(await boardPeople(tx, board)).some((p) => p.userId === userId)) gone.push(board.id)
  if (!gone.length) return []
  const now = new Date()
  await tx
    .update(tasks)
    .set({ assigneeId: null, updatedAt: now, version: sql`${tasks.version} + 1` })
    .where(and(inArray(tasks.boardId, gone), eq(tasks.assigneeId, userId)))
  // One statement per person field, changing only that key: a value someone else is setting on the same card for
  // another field isn't read and written back.
  const fields = await tx
    .selectDistinct({ id: boardFieldRows.fieldId })
    .from(boardFieldRows)
    .innerJoin(libraryFields, eq(libraryFields.id, boardFieldRows.fieldId))
    .where(and(inArray(boardFieldRows.boardId, gone), eq(libraryFields.type, 'person')))
  for (const { id } of fields) {
    const held = sql`${tasks.custom} -> ${id}::text`
    const left = sql`(${held}) - ${userId}::text`
    await tx
      .update(tasks)
      .set({
        custom: sql`nullif(case when jsonb_array_length(${left}) = 0 then ${tasks.custom} - ${id}::text else jsonb_set(${tasks.custom}, array[${id}::text], ${left}) end, '{}'::jsonb)`,
        updatedAt: now,
        version: sql`${tasks.version} + 1`,
      })
      .where(and(inArray(tasks.boardId, gone), sql`jsonb_typeof(${held}) = 'array'`, sql`jsonb_exists(${held}, ${userId}::text)`))
  }
  return gone
}
