import { newId } from '@kanbanto/model/ids'
import type { ColorName } from '@kanbanto/model/colors'
import { DEFAULT_ROLES, type Percent, type PlanData } from '@kanbanto/model/planning'
import type { PlanChange, PlanEntity, PlanRecords } from '@kanbanto/model/planningCommands'
import { comparePositions, positionBetween } from '@kanbanto/model/position'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db'
import { planningBlocks, planningLines, planningPeople, planningProjects, planningRoles, planningState, users } from '../db/schema'
import { HttpError } from '../http'

/**
 * A workspace's plan in the database (see model/planning.ts for what it is). Records come and go as the model's
 * changes say; `planning_state.seq` counts every change, so a page can tell it missed one.
 */

const iso = (d: Date) => d.toISOString()
const meta = (r: { createdAt: Date; updatedAt: Date; version: number }) => ({
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
  version: r.version,
})
const metaRow = (r: { createdAt: string; updatedAt: string; version: number }) => ({
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
  version: r.version,
})

/** A new workspace's plan: its change counter and the roles a plan starts with. */
export async function seedPlan(tx: Db | Tx, workspaceId: string) {
  await tx.insert(planningState).values({ workspaceId }).onConflictDoNothing()
  const now = new Date()
  let position: string | null = null
  const rows = DEFAULT_ROLES.map((name) => {
    position = positionBetween(position, null)
    return { id: newId(), workspaceId, name, position, createdAt: now, updatedAt: now, version: 1 }
  })
  await tx.insert(planningRoles).values(rows)
}

/** Counts a change to the plan (made outside the plan's own commands, like someone joining). */
export async function bumpPlan(tx: Db | Tx, workspaceId: string) {
  await tx
    .insert(planningState)
    .values({ workspaceId, seq: 1 })
    .onConflictDoUpdate({ target: planningState.workspaceId, set: { seq: sql`${planningState.seq} + 1` } })
}

/** Someone joined the workspace: they're in its plan (back in it, with their time, if they were before). */
export async function addPlanPerson(tx: Db | Tx, workspaceId: string, userId: string) {
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId))
  if (!u) return
  const now = new Date()
  await tx
    .insert(planningPeople)
    .values({ id: newId(), workspaceId, userId, name: u.name, roleId: null, hoursPerDay: 8, createdAt: now, updatedAt: now, version: 1 })
    .onConflictDoNothing()
  await bumpPlan(tx, workspaceId)
}

export interface LoadedPlan {
  plan: PlanData
  seq: number
  /** The last change to each project: when, and who made it (their name). */
  activity: Record<string, { at: string; by: string | null }>
}

/** A workspace's whole plan (plans are small: tens of people, hundreds of blocks). */
export async function loadPlan(tx: Db | Tx, workspaceId: string): Promise<LoadedPlan> {
  const [state] = await tx.select({ seq: planningState.seq }).from(planningState).where(eq(planningState.workspaceId, workspaceId))
  const roles = await tx.select().from(planningRoles).where(eq(planningRoles.workspaceId, workspaceId))
  const people = await tx
    .select({ p: planningPeople, account: users.name })
    .from(planningPeople)
    .leftJoin(users, eq(users.id, planningPeople.userId))
    .where(eq(planningPeople.workspaceId, workspaceId))
  const projects = await tx
    .select({ p: planningProjects, by: users.name })
    .from(planningProjects)
    .leftJoin(users, eq(users.id, planningProjects.activityBy))
    .where(eq(planningProjects.workspaceId, workspaceId))
  const lines = await tx.select().from(planningLines).where(eq(planningLines.workspaceId, workspaceId))
  const blocks = await tx.select().from(planningBlocks).where(eq(planningBlocks.workspaceId, workspaceId))
  const activity: LoadedPlan['activity'] = {}
  for (const { p, by } of projects) if (p.activityAt) activity[p.id] = { at: iso(p.activityAt), by }
  return {
    seq: state?.seq ?? 0,
    activity,
    plan: {
      roles: roles
        .map((r) => ({ id: r.id, name: r.name, position: r.position, ...meta(r) }))
        .sort((a, b) => comparePositions(a.position, b.position)),
      // A member's name is their account's (the stored copy is for when the account is gone).
      people: people.map(({ p, account }) => ({
        id: p.id,
        userId: p.userId,
        name: account ?? p.name,
        roleId: p.roleId,
        hoursPerDay: p.hoursPerDay,
        ...meta(p),
      })),
      projects: projects
        .map(({ p }) => ({
          id: p.id,
          name: p.name,
          client: p.client,
          plannedMd: p.plannedMd,
          color: p.color as ColorName,
          position: p.position,
          finishedAt: p.finishedAt ? iso(p.finishedAt) : null,
          openLines: p.openLines,
          ...meta(p),
        }))
        .sort((a, b) => comparePositions(a.position, b.position)),
      lines: lines.map((l) => ({ id: l.id, projectId: l.projectId, personId: l.personId, ...meta(l) })),
      blocks: blocks.map((b) => ({
        id: b.id,
        projectId: b.projectId,
        personId: b.personId,
        slot: b.slot,
        start: b.start,
        end: b.end,
        pct: b.pct as Percent,
        ...meta(b),
      })),
    },
  }
}

const TABLES = {
  role: planningRoles,
  person: planningPeople,
  project: planningProjects,
  line: planningLines,
  block: planningBlocks,
} as const

function toRow(workspaceId: string, c: PlanChange, userId: string) {
  switch (c.entity) {
    case 'role': {
      const r = c.after!
      return { id: r.id, workspaceId, name: r.name, position: r.position, ...metaRow(r) }
    }
    case 'person': {
      const r = c.after!
      return { id: r.id, workspaceId, userId: r.userId, name: r.name, roleId: r.roleId, hoursPerDay: r.hoursPerDay, ...metaRow(r) }
    }
    case 'project': {
      const r = c.after!
      return {
        id: r.id,
        workspaceId,
        name: r.name,
        client: r.client,
        plannedMd: r.plannedMd,
        color: r.color,
        position: r.position,
        finishedAt: r.finishedAt ? new Date(r.finishedAt) : null,
        openLines: r.openLines,
        ...metaRow(r),
      }
    }
    case 'line': {
      const r = c.after!
      return { id: r.id, workspaceId, projectId: r.projectId, personId: r.personId, ...metaRow(r) }
    }
    case 'block': {
      const r = c.after!
      return {
        id: r.id,
        workspaceId,
        projectId: r.projectId,
        personId: r.personId,
        slot: r.slot,
        start: r.start,
        end: r.end,
        pct: r.pct,
        updatedBy: userId,
        ...metaRow(r),
      }
    }
  }
}

// Parents are written before what points at them, and removed after it.
const WRITE_ORDER: PlanEntity[] = ['role', 'person', 'project', 'line', 'block']

/** Saves the model's changes. Ids for new records must not be in use anywhere (they're uuids shared by all plans). */
export async function writePlanChanges(tx: Tx, workspaceId: string, changes: PlanChange[], userId: string) {
  const last = new Map<string, PlanChange>()
  for (const c of changes) last.set(`${c.entity}:${c.id}`, c)
  const by = new Map<PlanEntity, PlanChange[]>(WRITE_ORDER.map((e) => [e, []]))
  for (const c of last.values()) by.get(c.entity)!.push(c)

  for (const entity of WRITE_ORDER) {
    const table = TABLES[entity]
    const cs = by.get(entity)!
    const created = cs.filter((c) => !c.before && c.after).map((c) => c.id)
    if (created.length) {
      const taken = await tx.select({ id: table.id }).from(table).where(inArray(table.id, created))
      if (taken.length) throw new HttpError(422, 'That id is already in use.')
    }
    for (const c of cs.filter((x) => x.after)) {
      const row = toRow(workspaceId, c, userId)
      const { id: _id, workspaceId: _ws, ...set } = row
      await tx
        .insert(table)
        .values(row as never)
        .onConflictDoUpdate({ target: table.id, set: set as never, setWhere: eq(table.workspaceId, workspaceId) })
    }
  }
  for (const entity of [...WRITE_ORDER].reverse()) {
    const table = TABLES[entity]
    const gone = by
      .get(entity)!
      .filter((c) => !c.after)
      .map((c) => c.id)
    if (gone.length) await tx.delete(table).where(and(eq(table.workspaceId, workspaceId), inArray(table.id, gone)))
  }

  // "Changed 2 days ago by Ann", for each project whose plan changed.
  const touched = new Set<string>()
  for (const c of last.values()) {
    const records = [c.before, c.after].filter(Boolean) as PlanRecords[PlanEntity][]
    for (const r of records) {
      if (c.entity === 'project') touched.add(r.id)
      if ((c.entity === 'block' || c.entity === 'line') && 'projectId' in r) touched.add(r.projectId)
    }
  }
  if (touched.size)
    await tx
      .update(planningProjects)
      .set({ activityAt: new Date(), activityBy: userId })
      .where(and(eq(planningProjects.workspaceId, workspaceId), inArray(planningProjects.id, [...touched])))
}
