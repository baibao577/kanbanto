import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Tx } from '../db'
import { boards, users } from '../db/schema'
import { accessOf, openBoards } from './access'

/**
 * People, visibility or invites changed: every cached and open copy of the board is refreshed (so new people
 * can be assigned right away), and anyone who lost access is disconnected.
 */
export async function announceSharingChange(app: FastifyInstance, boardId: string) {
  await app.engine.touch(boardId)
  const [board] = await app.db.select().from(boards).where(eq(boards.id, boardId))
  if (!board) return
  await app.hub.recheck(boardId, async (userId) => {
    if (userId) {
      const [u] = await app.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
      if (!u || u.disabledAt) return null
    }
    const access = await accessOf(app.db, board, userId ?? undefined)
    return access && (access.via === 'public' ? 'public' : 'member')
  })
}

/** A workspace's people (or name) changed: its boards are refreshed, and anyone who lost access is disconnected. */
export async function announceWorkspaceChange(app: FastifyInstance, workspaceId: string) {
  const rows = await app.db.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspaceId))
  for (const b of rows) await announceSharingChange(app, b.id)
}

/**
 * A person's name or picture is changing (`change` writes it): every board they're on shows them, so those boards'
 * change numbers go up with it, and once that's done their cached copies go and every open copy is fetched again.
 * (Not `touch`: nothing happened on those boards, so they don't move up among the recently active ones.)
 */
export async function changePerson(app: FastifyInstance, userId: string, change: (tx: Tx) => Promise<void>) {
  const ids = await app.db.transaction(async (tx) => {
    await change(tx)
    const ids = (await openBoards(tx, userId)).map((b) => b.id)
    await app.engine.bump(tx, ids)
    return ids
  })
  app.engine.reloaded(ids)
}
