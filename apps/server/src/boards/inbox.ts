import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import { inboxBoard } from '@kanbanto/model/sample'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { boards, users } from '../db/schema'
import { HttpError } from '../http'
import type { BoardRow } from './access'
import { insertBoard } from './service'

// Everyone has an Inbox: a board of their own for quick notes and cards that have no board yet. It's a real board
// (lists, cards, the three views), but it stays theirs alone: private, in Personal, and never shared, moved to a
// workspace, archived or deleted. It's made the first time it's needed.

export async function inboxIdOf(db: Db | Tx, userId: string): Promise<string | null> {
  const [b] = await db.select({ id: boards.id }).from(boards).where(eq(boards.inboxOf, userId))
  return b?.id ?? null
}

/** Their Inbox's id, making the board if they have none yet. */
export async function ensureInbox(db: Db, userId: string): Promise<string> {
  const have = await inboxIdOf(db, userId)
  if (have) return have
  return db.transaction(async (tx) => {
    // (One at a time per person, so two requests at once can't each make one.)
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update')
    const made = await inboxIdOf(tx, userId)
    if (made) return made
    const id = newId()
    await insertBoard(tx, inboxBoard(id, new Date().toISOString()), userId, null, { inbox: true })
    return id
  })
}

/** How many cards in it aren't done (its top-level cards: the number on the Inbox button). */
export async function inboxOpenCount(app: FastifyInstance, boardId: string): Promise<number> {
  const idx = indexFor((await app.engine.snapshot(boardId)).data)
  return idx.roots.filter((id) => idx.category.get(id) !== 'done').length
}

const INBOX_SAYS = {
  share: 'Your Inbox is only for you: it can’t be shared.',
  people: 'Your Inbox is yours alone: nobody else can be on it.',
  leave: 'Your Inbox is yours alone: it can’t be left.',
  workspace: 'Your Inbox stays with your Personal boards: it can’t be moved to a workspace.',
  archive: 'Your Inbox can’t be archived. Archive its cards instead.',
  delete: 'Your Inbox can’t be deleted. Delete or archive its cards instead.',
}

/** Refuses what can't be done to an Inbox. */
export function notOnInbox(board: Pick<BoardRow, 'inboxOf'>, what: keyof typeof INBOX_SAYS) {
  if (board.inboxOf) throw new HttpError(400, INBOX_SAYS[what], 'inbox')
}
