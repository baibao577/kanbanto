import type { BoardRule } from '@kanbanto/model/rules'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { requireAccess } from '../boards/access'
import { removeRule, saveRule } from '../boards/rules'
import { parse } from '../http'
import { requireUser } from './auth'

const Params = z.object({ id: z.string().min(1).max(100) })
const RuleParams = Params.extend({ ruleId: z.uuid() })
const Body = z.object({ rule: z.record(z.string(), z.unknown()) })

/**
 * A board's rules (see model rules.ts): its owners make, change and remove them. Everyone who can open the board
 * gets them with the board (`rules` in `GET /api/boards/:id`) and works out where each stands from the board itself.
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

  app.delete('/boards/:id/rules/:ruleId', async (req) => {
    const { id, ruleId } = parse(RuleParams, req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, me, id, 'owner')
    await removeRule(app, id, me, ruleId, req.apiToken?.app)
    return { ok: true }
  })
}
