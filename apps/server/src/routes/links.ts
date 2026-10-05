import type { LinkedCard, LinkedFrom, LinkPick } from '@kanbanto/model/api'
import { descendantsOf, indexFor } from '@kanbanto/model/indexer'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import { linkedFrom, pickCards, resolveLinks } from '../boards/links'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'

const BoardParams = z.object({ id: z.string().min(1).max(100) })
/** Links asked about at once (each is two ids and a colon). */
const MAX_ASKED = 60

/**
 * Links between cards (see boards/links.ts): what links point at, for the person asking; the cards a link field
 * offers; and who links to a card.
 */
export const linkRoutes: FastifyPluginAsync = async (app) => {
  const env = { db: app.db, engine: app.engine }

  /**
   * What these links point at (`refs`: links with commas, each written for an address). For the ones a board didn't
   * send with it: a link someone just added, or a card that's being opened. Only links a card of this board holds
   * are answered, so this can't be used to look cards up.
   */
  app.get('/boards/:id/linked', async (req): Promise<{ linked: Record<string, LinkedCard> }> => {
    const { id } = parse(BoardParams, req.params)
    const { refs } = parse(z.object({ refs: z.string().max(16_000) }), req.query)
    const { board, access } = await requireAccess(app.db, req.user, id, 'viewer')
    const { data } = await app.engine.snapshot(id)
    const asked = new Set(refs.split(',').filter(Boolean).slice(0, MAX_ASKED).map(decode))
    const links = data.fields.filter((f) => f.type === 'link')
    const held = new Set<string>()
    for (const t of [...Object.values(data.tasks), ...Object.values(data.archived ?? {})])
      for (const f of links) for (const ref of Array.isArray(t.custom?.[f.id]) ? (t.custom![f.id] as string[]) : []) if (asked.has(ref)) held.add(ref)
    return { linked: await resolveLinks(env, access.via === 'public' ? undefined : req.user?.id, board, data, [...held]) }
  })

  /** Cards to pick for one of the board's link fields: by words in their titles, or the latest ones (editors). */
  app.get('/boards/:id/fields/:fieldId/cards', async (req): Promise<{ cards: LinkPick[]; problem?: string }> => {
    const { id, fieldId } = parse(BoardParams.extend({ fieldId: z.uuid() }), req.params)
    const { q, task } = parse(z.object({ q: z.string().max(200).default(''), task: z.string().max(100).optional() }), req.query)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'editor')
    const { data } = await app.engine.snapshot(id)
    const field = data.fields.find((f) => f.id === fieldId && f.type === 'link')
    if (!field) throw new HttpError(404, 'That field is no longer on this board.')
    return pickCards(env, me.id, board, field, q, task)
  })

  /**
   * The cards that link to this one, grouped by the board and field they link from. `subtasks=1`: to it or to any
   * card under it (what moving it elsewhere would undo).
   */
  app.get('/boards/:id/tasks/:taskId/linked-from', async (req): Promise<LinkedFrom> => {
    const { id, taskId } = parse(BoardParams.extend({ taskId: z.string().min(1).max(100) }), req.params)
    const { subtasks } = parse(z.object({ subtasks: z.enum(['1']).optional() }), req.query)
    const { board, access } = await requireAccess(app.db, req.user, id, 'viewer')
    const { data } = await app.engine.snapshot(id)
    if (!data.tasks[taskId] && !data.archived?.[taskId]) throw new HttpError(404, 'That card no longer exists.')
    const under = subtasks && data.tasks[taskId] ? descendantsOf(indexFor(data), taskId) : []
    return linkedFrom(env, access.via === 'public' ? undefined : req.user?.id, board, [taskId, ...under])
  })
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
