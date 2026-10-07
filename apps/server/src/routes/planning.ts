import type { BoardPlan, PlanningMutationResult, PlanningView } from '@kanbanto/model/api'
import { projectFacts } from '@kanbanto/model/planning'
import { PlanCommandSchema } from '@kanbanto/model/planningSchema'
import { and, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { Db } from '../db'
import { requireAccess, workspaceRole } from '../boards/access'
import { requireWorkspace } from '../boards/workspaces'
import { boardsFor } from './boards'
import { loggedOn } from './time'
import { planningProjects, workspaceMembers } from '../db/schema'
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
    const { plan, seq, activity, pictures } = await loadPlan(app.db, id)
    const members = await app.db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, id))
    // The workspace's boards you can open: what a project can be linked to, and what its link opens.
    const boards = (await boardsFor(app.db, me.id))
      .filter((b) => b.workspaceId === id && !b.archivedAt)
      .map((b) => ({ id: b.id, name: b.name, background: b.background ?? null }))
    // Time logged on linked boards, from the ones this person can open (a board kept to fewer people keeps its
    // logged time to them too, whenever it was linked).
    const open = new Set(boards.map((b) => b.id))
    const actuals = await loggedOn(
      app.db,
      plan.projects.flatMap((p) => (p.boardId && open.has(p.boardId) ? [p.boardId] : [])),
    )
    return { plan, seq, canEdit, memberIds: members.map((m) => m.userId), activity, pictures, boards, actuals }
  })

  /** A board's project in its workspace's plan: who's booked on it, how much and until when (for its Timeline). */
  app.get('/boards/:id/plan', async (req): Promise<BoardPlan> => {
    const { id } = parse(z.object({ id: z.string().min(1).max(100) }), req.params)
    const me = requireUser(req.user)
    await requireAccess(app.db, req.user, id, 'viewer')
    const [link] = await app.db
      .select({ projectId: planningProjects.id, workspaceId: planningProjects.workspaceId })
      .from(planningProjects)
      .where(eq(planningProjects.boardId, id))
    // The plan is for the workspace's people: someone the board is shared with from outside doesn't see it.
    if (!link || !(await workspaceRole(app.db, link.workspaceId, me.id))) return { plan: null }
    const { plan, pictures } = await loadPlan(app.db, link.workspaceId)
    const project = plan.projects.find((p) => p.id === link.projectId)
    if (!project) return { plan: null }
    const blocks = plan.blocks.filter((b) => b.projectId === project.id).sort((a, b) => (a.start < b.start ? -1 : 1))
    const roles = new Map(plan.roles.map((r) => [r.id, r.name]))
    const lines: NonNullable<BoardPlan['plan']>['lines'] = []
    for (const personId of [...new Set(blocks.flatMap((b) => (b.personId ? [b.personId] : [])))]) {
      const person = plan.people.find((p) => p.id === personId)
      lines.push({
        key: personId,
        name: person?.name ?? 'Someone',
        ...(person?.userId && pictures[person.userId] && { picture: pictures[person.userId] }),
        role: (person?.roleId && roles.get(person.roleId)) || null,
        blocks: blocks.filter((b) => b.personId === personId).map(({ start, end, pct }) => ({ start, end, pct })),
      })
    }
    for (let slot = 0; slot < project.openLines; slot++) {
      const open = blocks.filter((b) => !b.personId && b.slot === slot)
      if (open.length) lines.push({ key: `open-${slot}`, name: null, role: null, blocks: open.map(({ start, end, pct }) => ({ start, end, pct })) })
    }
    const facts = projectFacts(plan, project.id)
    return {
      plan: {
        workspaceId: link.workspaceId,
        project: { id: project.id, name: project.name, plannedMd: project.plannedMd, color: project.color, prospect: project.prospect },
        scheduled: facts.scheduled,
        unassigned: facts.unassigned,
        lines,
      },
    }
  })

  app.post('/workspaces/:id/planning/mutations', async (req): Promise<PlanningMutationResult> => {
    const { id } = parse(Params, req.params)
    const me = requireUser(req.user)
    if (!(await canPlan(app.db, id, me.id))) throw new HttpError(403, 'Only the workspace’s admins and planners can change its plan.')
    const { mutationId, command } = parse(Mutation, req.body)
    return engine.mutate(id, mutationId, command, me.id)
  })
}
