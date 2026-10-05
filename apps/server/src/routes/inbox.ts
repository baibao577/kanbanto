import type { InboxInfo } from '@kanbanto/model/api'
import type { FastifyPluginAsync } from 'fastify'
import { ensureInbox, inboxIdOf, inboxOpenCount } from '../boards/inbox'
import { requireUser } from './auth'

export const inboxRoutes: FastifyPluginAsync = async (app) => {
  const info = async (boardId: string | null): Promise<InboxInfo> => ({ boardId, open: boardId ? await inboxOpenCount(app, boardId) : 0 })

  /** Your Inbox board and how many cards wait in it. `boardId` is null until it's been made (POST makes it). */
  app.get('/inbox', async (req) => info(await inboxIdOf(app.db, requireUser(req.user).id)))

  /** The same, making your Inbox first if you have none yet. */
  app.post('/inbox', async (req) => info(await ensureInbox(app.db, requireUser(req.user).id)))
}
