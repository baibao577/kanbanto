import type { InboxInfo } from '@kanbanto/model/api'
import type { FastifyPluginAsync } from 'fastify'
import { ensureInbox, inboxIdOf, inboxOpenCount } from '../boards/inbox'
import { addCardSaid, NewCardBody } from '../boards/newCards'
import { parse, siteUrl } from '../http'
import { requireUser } from './auth'

export const inboxRoutes: FastifyPluginAsync = async (app) => {
  const info = async (boardId: string | null): Promise<InboxInfo> => ({ boardId, open: boardId ? await inboxOpenCount(app, boardId) : 0 })

  /** Your Inbox board and how many cards wait in it. `boardId` is null until it's been made (POST makes it). */
  app.get('/inbox', async (req) => info(await inboxIdOf(app.db, requireUser(req.user).id)))

  /** The same, making your Inbox first if you have none yet. */
  app.post('/inbox', async (req) => info(await ensureInbox(app.db, requireUser(req.user).id)))

  /**
   * Adds a card to your Inbox, in one call, with plain names: for a script, an automation tool, a shortcut on a
   * phone. (Your Inbox is made first, if you have none yet.) `POST /api/boards/:id/cards` is the same for a board.
   */
  app.post('/inbox/cards', async (req) => {
    const me = requireUser(req.user)
    return addCardSaid(app, { me, via: req.apiToken?.app }, null, parse(NewCardBody, req.body), app.mail.siteUrl ?? siteUrl(req))
  })
}
