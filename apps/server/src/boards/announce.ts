import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { boards, users } from '../db/schema'
import { accessOf } from './access'

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
      if (!u || u.disabledAt) return false
    }
    return !!(await accessOf(app.db, board, userId ?? undefined))
  })
}

/** A workspace's people (or name) changed: its boards are refreshed, and anyone who lost access is disconnected. */
export async function announceWorkspaceChange(app: FastifyInstance, workspaceId: string) {
  const rows = await app.db.select({ id: boards.id }).from(boards).where(eq(boards.workspaceId, workspaceId))
  for (const b of rows) await announceSharingChange(app, b.id)
}
