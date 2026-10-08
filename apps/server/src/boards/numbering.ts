import { indexFor } from '@kanbanto/model/indexer'
import { INBOX_CODE, isCode, numbersFor, PAST_CODES, suggestCode } from '@kanbanto/model/refs'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { boardMembers, boards, users, workspaces } from '../db/schema'
import { HttpError } from '../http'
import { loadBoard } from './store'

// Card numbers (see model/refs.ts): the letters a board may take, changing them, and giving letters and numbers to
// what was made before there were any. A card's number itself is given in boards/engine.ts, as it's saved.

/** Where a board's letters have to be its own: its workspace, or the Personal boards of the people who own it. */
export type Space = { workspaceId: string } | { ownerIds: string[] }

/** The space a saved board is in. */
export async function spaceOf(tx: Db | Tx, board: { id: string; workspaceId: string | null }): Promise<Space> {
  if (board.workspaceId) return { workspaceId: board.workspaceId }
  const owners = await tx
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.role, 'owner')))
  return { ownerIds: owners.map((o) => o.userId).sort() }
}

/**
 * One board at a time takes letters in a space, so two can't take the same ones. (A workspace is locked like its
 * field library is, and its boards' letters are also kept apart by the database. Personal boards: the people who own
 * the board are locked, always in the same order.)
 */
export async function lockSpace(tx: Tx, space: Space) {
  if ('workspaceId' in space) await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, space.workspaceId)).for('update')
  else for (const id of [...space.ownerIds].sort()) await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update')
}

/**
 * The letters boards in a space have, and the ones they had before (a number written with those still means their
 * card). `except`: a board that doesn't count (the one being given letters).
 */
export async function codesTaken(tx: Db | Tx, space: Space, except?: string): Promise<Set<string>> {
  const not = except ? ne(boards.id, except) : undefined
  let rows: { code: string | null; pastCodes: string[] }[]
  if ('workspaceId' in space) {
    rows = await tx
      .select({ code: boards.code, pastCodes: boards.pastCodes })
      .from(boards)
      .where(and(eq(boards.workspaceId, space.workspaceId), not))
  } else if (space.ownerIds.length) {
    const theirs = tx
      .select({ id: boardMembers.boardId })
      .from(boardMembers)
      .where(and(eq(boardMembers.role, 'owner'), inArray(boardMembers.userId, space.ownerIds)))
    rows = await tx
      .select({ code: boards.code, pastCodes: boards.pastCodes })
      .from(boards)
      .where(and(isNull(boards.workspaceId), inArray(boards.id, theirs), not))
  } else rows = []
  // (The Inbox's letters are the Inbox's, whether or not this person has one yet.)
  const out = new Set<string>([INBOX_CODE])
  for (const r of rows) {
    if (r.code) out.add(r.code)
    for (const c of r.pastCodes) out.add(c)
  }
  return out
}

/** The letters a board had, with `was` put first: what `past_codes` becomes when its letters change to `now`. */
const pastWith = (past: string[], was: string | null, now: string) =>
  [...(was ? [was] : []), ...past].filter((c, i, all) => c !== now && all.indexOf(c) === i).slice(0, PAST_CODES)

/**
 * Changes a board's letters (its owners do, in Board settings): every card is called by the new ones at once, and the
 * old ones are remembered, so a number written with them still finds its card. Refused when another board in the same
 * space has them, or had them. Call `engine.bump` in the same transaction and `engine.reloaded` after it: no command
 * carries this, so that's how open copies learn of it.
 */
export async function setBoardCode(tx: Tx, boardId: string, code: string): Promise<{ code: string; pastCodes: string[] }> {
  if (!isCode(code)) throw new HttpError(400, 'Use 2 to 5 letters or digits, starting with a letter.')
  const [first] = await tx.select({ id: boards.id, workspaceId: boards.workspaceId }).from(boards).where(eq(boards.id, boardId))
  if (!first) throw new HttpError(404, 'This board no longer exists.')
  await lockSpace(tx, await spaceOf(tx, first))
  const [row] = await tx
    .select({ id: boards.id, code: boards.code, pastCodes: boards.pastCodes, workspaceId: boards.workspaceId, inboxOf: boards.inboxOf })
    .from(boards)
    .where(eq(boards.id, boardId))
    .for('update')
  if (!row) throw new HttpError(404, 'This board no longer exists.')
  if (row.inboxOf) throw new HttpError(400, 'The Inbox keeps its letters.')
  if (row.code === code) return { code, pastCodes: row.pastCodes }
  // (Its own old letters are its own to take back.)
  if (!row.pastCodes.includes(code) && (await codesTaken(tx, await spaceOf(tx, row), boardId)).has(code))
    throw new HttpError(
      409,
      code === INBOX_CODE ? 'IN is the Inbox’s. Choose other letters.' : `Another board here uses ${code}. Choose other letters.`,
    )
  const pastCodes = pastWith(row.pastCodes, row.code, code)
  await tx.update(boards).set({ code, pastCodes }).where(eq(boards.id, boardId))
  return { code, pastCodes }
}

/**
 * A board about to arrive in another space (moved to a workspace, or back to Personal) keeps its letters when nobody
 * there has them. When someone does, it gets new ones from its name and remembers the old. Returns what to write
 * with the move (in the same statement: a workspace's boards can't share letters even for a moment), or nothing when
 * the letters stay. The space is locked first.
 */
export async function codeIn(
  tx: Tx,
  board: { id: string; name: string; code: string | null; pastCodes: string[] },
  space: Space,
): Promise<{ code: string; pastCodes: string[] } | undefined> {
  await lockSpace(tx, space)
  if (!board.code) return undefined
  const taken = await codesTaken(tx, space, board.id)
  if (!taken.has(board.code)) return undefined
  const code = suggestCode(board.name, taken)
  return { code, pastCodes: pastWith(board.pastCodes, board.code, code) }
}

/**
 * Gives one board what it lacks: letters, when it has none, and a number for every card without one, in the order
 * the cards were made (and where many were made in one moment, a starter or an import, in the order the outline
 * shows them). Cards that have a number keep it. Its row must be locked by the caller. Returns how many cards it
 * numbered, or null when there was nothing to do (nothing is written then, and `seq` is the caller's to move).
 */
export async function numberBoard(tx: Tx, boardId: string): Promise<{ cards: number; nextNumber: number } | null> {
  const [row] = await tx
    .select({
      id: boards.id,
      name: boards.name,
      code: boards.code,
      nextNumber: boards.nextNumber,
      workspaceId: boards.workspaceId,
      inboxOf: boards.inboxOf,
    })
    .from(boards)
    .where(eq(boards.id, boardId))
  const loaded = row && (await loadBoard(tx, boardId))
  if (!row || !loaded) return null
  const { data } = loaded
  const all = [...Object.values(data.tasks), ...Object.values(data.archived ?? {})]
  const missing = all.filter((t) => !t.number)
  const { numbers, next } = numbersFor(all, indexFor(data).preorder, row.nextNumber)
  if (row.code && !missing.length && next <= row.nextNumber) return null
  let code = row.code
  if (!code) {
    if (row.inboxOf) code = INBOX_CODE
    else {
      const space = await spaceOf(tx, row)
      code = suggestCode(row.name, await codesTaken(tx, space, boardId))
    }
  }
  for (let i = 0; i < missing.length; i += 500) {
    const values = sql.join(
      missing.slice(i, i + 500).map((t) => sql`(${t.id}::text, ${numbers.get(t.id)!}::integer)`),
      sql`, `,
    )
    await tx.execute(sql`
      update tasks t set number = v.number
      from (values ${values}) as v(id, number)
      where t.board_id = ${boardId} and t.id = v.id and t.number is null`)
  }
  const nextNumber = Math.max(next, row.nextNumber)
  await tx.update(boards).set({ code, nextNumber }).where(eq(boards.id, boardId))
  return { cards: missing.length, nextNumber }
}

/**
 * Run when the server starts, after the database is brought up to date: every board made before card numbers gets
 * its letters, and every card its number (see `numberBoard`). One board at a time, each in its own transaction, so
 * it can be stopped and run again, and two servers starting together don't number anything twice (the second finds
 * the first's work done). A board that needs nothing isn't touched. Boards it changes get the next `seq`: a copy held
 * anywhere is read again.
 */
export async function numberBoards(db: Db): Promise<{ boards: number; cards: number }> {
  const todo = (await db.execute(sql`
    select b.id, b.workspace_id as "workspaceId" from boards b
    where b.code is null or exists (select 1 from tasks t where t.board_id = b.id and t.number is null)
    order by b.created_at, b.id`)) as unknown as { id: string; workspaceId: string | null }[]
  let changed = 0
  let cards = 0
  for (const b of todo) {
    const did = await db.transaction(async (tx) => {
      // (The space first, then the board: the order everything that takes letters locks in.)
      await lockSpace(tx, await spaceOf(tx, b))
      const [row] = await tx.select({ id: boards.id }).from(boards).where(eq(boards.id, b.id)).for('update')
      if (!row) return null
      const done = await numberBoard(tx, b.id)
      if (done)
        await tx
          .update(boards)
          .set({ seq: sql`${boards.seq} + 1` })
          .where(eq(boards.id, b.id))
      return done
    })
    if (did) {
      changed++
      cards += did.cards
    }
  }
  return { boards: changed, cards }
}
