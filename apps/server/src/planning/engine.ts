import { newId } from '@kanbanto/model/ids'
import { executePlan, type PlanChange, type PlanCommand } from '@kanbanto/model/planningCommands'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { planningState, workspaceMembers } from '../db/schema'
import { HttpError } from '../http'
import { loadPlan, writePlanChanges } from './store'

export interface PlanMutationResult {
  seq: number
  changes: PlanChange[]
}

const REMEMBERED_MUTATIONS = 500
/** Database refusals a change can still run into (a record removed or reused at the same moment). */
const CONFLICTS = new Set(['23503', '23505', '23514'])

/**
 * Runs plan commands: the same `executePlan` the page runs, but here it's the one that counts. Changes to one
 * workspace's plan happen one at a time (its planning_state row is locked), each gets the next `seq`. Retried
 * requests (same mutation id) get the first answer back instead of running twice.
 */
export class PlanningEngine {
  private done = new Map<string, PlanMutationResult>()
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  async mutate(workspaceId: string, mutationId: string, command: PlanCommand, userId: string): Promise<PlanMutationResult> {
    const key = `${workspaceId}:${userId}:${mutationId}`
    const prior = this.done.get(key)
    if (prior) return prior

    let out: PlanMutationResult
    try {
      out = await this.db.transaction(async (tx) => {
        await tx.insert(planningState).values({ workspaceId }).onConflictDoNothing()
        const [row] = await tx.select({ seq: planningState.seq }).from(planningState).where(eq(planningState.workspaceId, workspaceId)).for('update')
        const { plan } = await loadPlan(tx, workspaceId)
        const members = await tx
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, workspaceId))
        let r: ReturnType<typeof executePlan>
        try {
          r = executePlan(plan, command, { now: new Date().toISOString(), newId, members: new Set(members.map((m) => m.userId)) })
        } catch (e) {
          throw Object.assign(new HttpError(422, 'That change couldn’t be applied to the plan.'), { cause: e })
        }
        if ('error' in r) throw new HttpError(422, r.error)
        if (!r.changes.length) return { seq: row.seq, changes: [] }
        await writePlanChanges(tx, workspaceId, r.changes, userId)
        const seq = row.seq + 1
        await tx.update(planningState).set({ seq }).where(eq(planningState.workspaceId, workspaceId))
        return { seq, changes: r.changes }
      })
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code
      if (code && CONFLICTS.has(code)) throw new HttpError(422, 'That doesn’t fit the plan any more. Reload it and try again.')
      throw e
    }
    this.done.set(key, out)
    if (this.done.size > REMEMBERED_MUTATIONS) this.done.delete(this.done.keys().next().value!)
    return out
  }
}
