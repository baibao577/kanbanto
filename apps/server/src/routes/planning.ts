import type { PlanningMutationResult, PlanningView } from '@kanbanto/model/api'
import { PlanCommandSchema } from '@kanbanto/model/planningSchema'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db'
import { requireWorkspace } from '../boards/workspaces'
import { workspaceMembers } from '../db/schema'
import { HttpError, parse } from '../http'
import { PlanningEngine } from '../planning/engine'
import { loadPlan } from '../planning/store'
import { requireUser } from './auth'

const Params = z.object({ id: z.uuid() })
const Mutation = z.object({ mutationId: z.string().min(1).max(100), command: PlanCommandSchema }).strict()

/** Admins and the members they've made planners can change a workspace's plan; everyone in it can see it. */
async function canPlan(db: Db, workspaceId: string, userId: string) {
  const { role } = await requireWorkspace(db, workspaceId, userId)
  if (role === 'admin') return true
  const [m] = await db
    .select({ planner: workspaceMembers.planner })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
  return !!m?.planner
}

/** A workspace's plan: who works on which project, when, and how much (see model/planning.ts). */
export const planningRoutes: FastifyPluginAsync = async (app) => {
  const engine = new PlanningEngine(app.db)

  app.get('/workspaces/:id/planning', async (req): Promise<PlanningView> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    const canEdit = await canPlan(app.db, id, me.id)
    const { plan, seq, activity } = await loadPlan(app.db, id)
    const members = await app.db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, id))
    return { plan, seq, canEdit, memberIds: members.map((m) => m.userId), activity }
  })

  app.post('/workspaces/:id/planning/mutations', async (req): Promise<PlanningMutationResult> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    if (!(await canPlan(app.db, id, me.id))) throw new HttpError(403, 'Only the workspace’s admins and planners can change its plan.')
    const { mutationId, command } = parse(Mutation, req.body)
    return engine.mutate(id, mutationId, command, me.id)
  })
}
