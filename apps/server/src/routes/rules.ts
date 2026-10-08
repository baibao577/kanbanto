import type { BoardRule } from '@kanbanto/model/rules'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import { removeRule, ruleMutes, saveRule, setRuleMute } from '../boards/rules'
import { HttpError, parse } from '../http'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100) })
const RuleParams = Params.extend({ ruleId: z.uuid() })
const Body = z.object({ rule: z.record(z.string(), z.unknown()) })

/**
 * A board's rules (see model rules.ts): its owners make, change and remove them. Everyone who can open the board
 * gets them with the board (`rules` in `GET /api/boards/:id`) and works out where each stands from the board itself.
 * A rule that tells people can be switched off by each person for themselves, which is asked for and kept apart.
 */
export const ruleRoutes: FastifyPluginAsync = async (app) => {
  app.post('/boards/:id/rules', async (req): Promise<{ rule: BoardRule }> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'owner')
    const { rule } = parse(Body, req.body)
    return { rule: await saveRule(app, id, me, rule, undefined, req.apiToken?.app) }
  })

  app.patch('/boards/:id/rules/:ruleId', async (req): Promise<{ rule: BoardRule }> => {
    const { id, ruleId } = parse(RuleParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'owner')
    const { rule } = parse(Body, req.body)
    return { rule: await saveRule(app, id, me, rule, ruleId, req.apiToken?.app) }
  })

  /**
   * The rules you switched off for yourself (`mine`), and for the board's owners who switched off which (`all`).
   * A visitor with the public link has switched off none.
   */
  app.get('/boards/:id/rules/mutes', async (req) => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer')
    if (access.via === 'public') return { mine: [] }
    return ruleMutes(app.db, id, me.id, access.role === 'owner')
  })

  /**
   * Stops a rule telling you, or lets it again. Everyone on the board can (viewers too): it's about their own news,
   * and nothing about the board changes. Visitors with the public link can't.
   */
  app.put('/boards/:id/rules/:ruleId/mute', async (req) => {
    const { id, ruleId } = parse(RuleParams, req.params)
    const me = requireUser(req.user)
    const { access } = await requireAccess(app.db, me, id, 'viewer', { write: true })
    if (access.via === 'public') throw new HttpError(403, 'Join this board to change what its rules tell you.')
    const { muted } = parse(z.object({ muted: z.boolean() }), req.body)
    await setRuleMute(app.db, id, ruleId, me.id, muted)
    return { muted }
  })

  app.delete('/boards/:id/rules/:ruleId', async (req) => {
    const { id, ruleId } = parse(RuleParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'owner')
    await removeRule(app, id, me, ruleId, req.apiToken?.app)
    return { ok: true }
  })
}
