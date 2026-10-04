import { COLORS, LABEL_COLOR_CYCLE, type ColorName } from './colors'
import { fromDay, hasTime, normalizeTaskDate, toDay } from './dates'
import {
  canSplit,
  overlapsOnLine,
  peopleInOrder,
  PERCENTS,
  prevWorkDay,
  WORK_WEEK,
  workDays,
  type Percent,
  type PlanBlock,
  type PlanData,
  type PlanLine,
  type PlanPerson,
  type PlanProject,
  type PlanRole,
  type WorkWeek,
} from './planning'
import { comparePositions, positionBetween } from './position'
import { stamp } from './records'

/**
 * Every change to a plan is one of these commands, checked against the rules by `executePlan`, which returns the
 * exact records that change, the same way board commands work (commands.ts). The server runs the same code, so what
 * the page shows at once is what gets saved.
 */
export type PlanCommand =
  | { type: 'block.add'; id?: string; projectId: string; personId: string | null; slot?: number; start: string; end: string; pct: Percent }
  | { type: 'block.update'; id: string; fields: BlockFields }
  /** Cuts a block in two: the second part starts on `at`, the first ends on the working day before. */
  | { type: 'block.split'; id: string; at: string; newId?: string }
  | { type: 'block.remove'; id: string }
  | { type: 'project.add'; id?: string; name: string; client?: string; plannedMd?: number | null; color?: ColorName; prospect?: boolean }
  | { type: 'project.update'; id: string; fields: ProjectFields }
  | { type: 'project.move'; id: string; beforeId?: string }
  /** Deletes a project with its blocks and lines. */
  | { type: 'project.remove'; id: string }
  /** One more "not assigned yet" line on a project (a need nobody is chosen for yet). */
  | { type: 'project.addOpenLine'; id: string }
  /** Takes away an empty "not assigned yet" line (a project keeps at least one). */
  | { type: 'project.removeOpenLine'; id: string; slot: number }
  | { type: 'person.add'; id?: string; name: string; roleId?: string | null; hoursPerDay?: number }
  | { type: 'person.update'; id: string; fields: PersonFields }
  /** Puts someone before another person (or last) in the plan's order of people. */
  | { type: 'person.move'; id: string; beforeId?: string }
  /** Someone added by name turns out to be a workspace member: their blocks and lines move to the member, then they go. */
  | { type: 'person.merge'; id: string; into: string }
  /** Takes someone out of the plan; their blocks become "not assigned yet". */
  | { type: 'person.remove'; id: string }
  | { type: 'line.add'; id?: string; projectId: string; personId: string }
  | { type: 'line.remove'; projectId: string; personId: string }
  | { type: 'role.add'; id?: string; name: string }
  | { type: 'role.update'; id: string; name: string }
  | { type: 'role.move'; id: string; beforeId?: string }
  /** Removes a role; people who had it get none. */
  | { type: 'role.remove'; id: string }
  /** Puts records back the way they were (undo/redo), refused if someone changed them since. */
  | { type: 'plan.restore'; changes: PlanChange[] }

export type BlockFields = Partial<Pick<PlanBlock, 'projectId' | 'personId' | 'slot' | 'start' | 'end' | 'pct'>>
export type ProjectFields = Partial<Pick<PlanProject, 'name' | 'client' | 'plannedMd' | 'color' | 'boardId' | 'prospect'> & { finished: boolean }>
export type PersonFields = Partial<Pick<PlanPerson, 'name' | 'roleId' | 'hoursPerDay'>>

export interface PlanRecords {
  role: PlanRole
  person: PlanPerson
  project: PlanProject
  line: PlanLine
  block: PlanBlock
}
export type PlanEntity = keyof PlanRecords

/** One record changing: created (before = null), deleted (after = null) or edited. */
export type PlanChange = { [K in PlanEntity]: { entity: K; id: string; before: PlanRecords[K] | null; after: PlanRecords[K] | null } }[PlanEntity]

export interface PlanContext {
  now: string
  newId: () => string
  /** The accounts in the workspace right now: they stay in the plan while they're in it. */
  members: ReadonlySet<string>
  week?: WorkWeek
}

export type PlanResult = { changes: PlanChange[] } | { error: string }

/** Limits, so a plan stays a size a page can draw. */
export const PLAN_LIMITS = {
  projects: 500,
  people: 1000,
  roles: 50,
  blocks: 20_000,
  name: 100,
  role: 20,
  plannedMd: 1_000_000,
  days: 3660,
  openLines: 20,
  lines: 20_000,
  /** The years a plan covers: what reads it walks through its days. */
  from: '2000-01-01',
  to: '2100-12-31',
}

const LISTS = { role: 'roles', person: 'people', project: 'projects', line: 'lines', block: 'blocks' } as const satisfies Record<
  PlanEntity,
  keyof PlanData
>

/** The record a change is about, as it is now (null if it doesn't exist). */
export function currentPlanRecord<K extends PlanEntity>(plan: PlanData, entity: K, id: string): PlanRecords[K] | null {
  return ((plan[LISTS[entity]] as { id: string }[]).find((r) => r.id === id) as PlanRecords[K] | undefined) ?? null
}

/** Applies changes, copying only the lists that change. Roles and projects stay in their order. */
export function applyPlanChanges(plan: PlanData, changes: PlanChange[]): PlanData {
  if (!changes.length) return plan
  const maps = new Map<keyof PlanData, Map<string, { id: string }>>()
  for (const c of changes) {
    const list = LISTS[c.entity]
    let m = maps.get(list)
    if (!m) maps.set(list, (m = new Map((plan[list] as { id: string }[]).map((r) => [r.id, r]))))
    if (c.after) m.set(c.id, c.after)
    else m.delete(c.id)
  }
  const next = { ...plan } as Record<keyof PlanData, unknown[]>
  for (const [list, m] of maps) next[list] = [...m.values()]
  const out = next as unknown as PlanData
  if (maps.has('roles')) out.roles.sort((a, b) => comparePositions(a.position, b.position))
  if (maps.has('projects')) out.projects.sort((a, b) => comparePositions(a.position, b.position))
  return out
}

/** The changes that undo `changes`, given the plan as it is now (restoring is itself a change: new versions). */
export function invertPlanChanges(plan: PlanData, changes: PlanChange[], now: string): PlanChange[] {
  return [...changes].reverse().map((c) => {
    const cur = currentPlanRecord(plan, c.entity, c.id)
    const after = c.before ? { ...c.before, version: (cur?.version ?? c.before.version) + 1, updatedAt: now } : null
    return { entity: c.entity, id: c.id, before: cur, after } as PlanChange
  })
}

/** Runs a command against the plan. Returns the changes, or why it isn't allowed (in words for people). */
export function executePlan(plan: PlanData, cmd: PlanCommand, ctx: PlanContext): PlanResult {
  try {
    return { changes: run(plan, cmd, ctx) }
  } catch (e) {
    if (e instanceof Refused) return { error: e.message }
    throw e
  }
}

class Refused extends Error {}
const refuse = (message: string): never => {
  throw new Refused(message)
}

/** A whole day, "2026-10-15" (blocks don't have times). */
const isDay = (v: unknown): v is string => typeof v === 'string' && !hasTime(v) && normalizeTaskDate(v) === v
const cleanName = (v: string, max: number, what: string) => {
  const s = v.replace(/\s+/g, ' ').trim()
  if (!s) refuse(`Give the ${what} a name.`)
  if (s.length > max) refuse(`Keep the ${what}'s name under ${max} characters.`)
  return s
}
const cleanMd = (v: number | null | undefined) => {
  if (v === null || v === undefined) return null
  if (!Number.isFinite(v) || v < 0 || v > PLAN_LIMITS.plannedMd) refuse('Planned man-days is a number, 0 or more.')
  return Math.round(v * 100) / 100
}
const cleanHours = (v: number) => {
  if (!Number.isFinite(v) || v < 0.5 || v > 24) refuse('Hours a day is between 0.5 and 24.')
  return Math.round(v * 2) / 2
}
const isColor = (c: unknown): c is ColorName => COLORS.some((x) => x.id === c)

function run(plan: PlanData, cmd: PlanCommand, ctx: PlanContext): PlanChange[] {
  const { now } = ctx
  const week = ctx.week ?? WORK_WEEK
  const out: PlanChange[] = []
  const put = <K extends PlanEntity>(entity: K, before: PlanRecords[K] | null, next: Omit<PlanRecords[K], 'createdAt' | 'updatedAt' | 'version'>) =>
    out.push({ entity, id: next.id, before, after: stamp(before, next as never, now) } as PlanChange)
  const drop = <K extends PlanEntity>(entity: K, before: PlanRecords[K]) => out.push({ entity, id: before.id, before, after: null } as PlanChange)

  const project = (id: string) => plan.projects.find((p) => p.id === id) ?? refuse('That project is no longer in the plan.')
  const person = (id: string) => plan.people.find((p) => p.id === id) ?? refuse('That person is no longer in the plan.')
  const role = (id: string) => plan.roles.find((r) => r.id === id) ?? refuse('That role is no longer in the plan.')
  const block = (id: string) => plan.blocks.find((b) => b.id === id) ?? refuse('That block is no longer in the plan.')
  const fresh = (list: keyof PlanData, id: string) => {
    if ((plan[list] as { id: string }[]).some((r) => r.id === id)) refuse('That id is already in use.')
    return id
  }
  const who = (personId: string | null) => (personId ? (plan.people.find((p) => p.id === personId)?.name ?? 'them') : 'nobody yet')

  /** Checks a block as it would be (on `on`, the plan it lives in) and returns it. Someone's time is on line 0. */
  const checked = (block: Omit<PlanBlock, 'createdAt' | 'updatedAt' | 'version'>, on: PlanData = plan) => {
    const b = { ...block, slot: block.personId === null ? block.slot : 0 }
    const p = on.projects.find((x) => x.id === b.projectId) ?? refuse('That project is no longer in the plan.')
    if (!Number.isInteger(b.slot) || b.slot < 0 || b.slot >= p.openLines) refuse('That “not assigned yet” line is no longer there.')
    if (b.personId !== null && !on.people.some((x) => x.id === b.personId)) refuse('That person is no longer in the plan.')
    if (!(PERCENTS as readonly number[]).includes(b.pct)) refuse('Time on a project is 25, 50, 75 or 100%.')
    if (!isDay(b.start) || !isDay(b.end)) refuse('Dates look like 2026-10-31.')
    const s = toDay(b.start)
    const e = toDay(b.end)
    if (e < s) refuse('A block has to end on or after its start.')
    if (s < toDay(PLAN_LIMITS.from) || e > toDay(PLAN_LIMITS.to)) refuse('Dates in a plan are between 2000 and 2100.')
    if (e - s > PLAN_LIMITS.days) refuse('A block can be up to ten years long.')
    if (!workDays(s, e, week)) refuse('A block needs at least one working day.')
    if (overlapsOnLine(on, b.projectId, b.personId, s, e, b.id, b.slot))
      refuse(
        b.personId
          ? `That would overlap another block of ${who(b.personId)} on ${p.name}.`
          : `That would overlap another unassigned block on ${p.name}.`,
      )
    return b
  }
  const lastPosition = (list: { position: string }[]) => (list.length ? list[list.length - 1].position : null)
  const positionBefore = (list: { id: string; position: string }[], id: string, beforeId?: string) => {
    const others = list.filter((x) => x.id !== id)
    if (!beforeId) return positionBetween(lastPosition(others), null)
    const i = others.findIndex((x) => x.id === beforeId)
    if (i < 0) refuse('That item is no longer in the plan.')
    return positionBetween(others[i - 1]?.position ?? null, others[i].position)
  }

  switch (cmd.type) {
    case 'block.add': {
      if (plan.blocks.length >= PLAN_LIMITS.blocks) refuse(`A plan can have up to ${PLAN_LIMITS.blocks} blocks.`)
      const id = fresh('blocks', cmd.id ?? ctx.newId())
      put(
        'block',
        null,
        checked({ id, projectId: cmd.projectId, personId: cmd.personId, slot: cmd.slot ?? 0, start: cmd.start, end: cmd.end, pct: cmd.pct }),
      )
      break
    }
    case 'block.update': {
      const b = block(cmd.id)
      put('block', b, checked({ ...b, ...cmd.fields }))
      break
    }
    case 'block.split': {
      const b = block(cmd.id)
      if (!isDay(cmd.at) || !canSplit(b, toDay(cmd.at), week)) refuse('A block can only be split inside it, leaving working days on both sides.')
      if (plan.blocks.length >= PLAN_LIMITS.blocks) refuse(`A plan can have up to ${PLAN_LIMITS.blocks} blocks.`)
      const id = fresh('blocks', cmd.newId ?? ctx.newId())
      const at = toDay(cmd.at)
      put('block', b, { ...b, end: fromDay(prevWorkDay(at - 1, week)) })
      put('block', null, { id, projectId: b.projectId, personId: b.personId, slot: b.slot, start: cmd.at, end: b.end, pct: b.pct })
      break
    }
    case 'block.remove':
      drop('block', block(cmd.id))
      break

    case 'project.add': {
      if (plan.projects.length >= PLAN_LIMITS.projects) refuse(`A plan can have up to ${PLAN_LIMITS.projects} projects.`)
      const id = fresh('projects', cmd.id ?? ctx.newId())
      if (cmd.color !== undefined && !isColor(cmd.color)) refuse('That isn’t one of the colors.')
      put('project', null, {
        id,
        name: cleanName(cmd.name, PLAN_LIMITS.name, 'project'),
        client: (cmd.client ?? '').trim().slice(0, PLAN_LIMITS.name),
        plannedMd: cleanMd(cmd.plannedMd),
        color: cmd.color ?? LABEL_COLOR_CYCLE[plan.projects.length % LABEL_COLOR_CYCLE.length],
        position: positionBetween(lastPosition(plan.projects), null),
        finishedAt: null,
        openLines: 1,
        boardId: null,
        prospect: cmd.prospect ?? false,
      })
      break
    }
    case 'project.update': {
      const p = project(cmd.id)
      const f = cmd.fields
      if (f.color !== undefined && !isColor(f.color)) refuse('That isn’t one of the colors.')
      const linked = f.boardId ? plan.projects.find((x) => x.id !== p.id && x.boardId === f.boardId) : null
      if (linked) refuse(`That board is already linked to ${linked.name}.`)
      put('project', p, {
        ...p,
        ...(f.name !== undefined && { name: cleanName(f.name, PLAN_LIMITS.name, 'project') }),
        ...(f.client !== undefined && { client: f.client.trim().slice(0, PLAN_LIMITS.name) }),
        ...(f.plannedMd !== undefined && { plannedMd: cleanMd(f.plannedMd) }),
        ...(f.color !== undefined && { color: f.color }),
        ...(f.finished !== undefined && { finishedAt: f.finished ? (p.finishedAt ?? now) : null }),
        ...(f.boardId !== undefined && { boardId: f.boardId }),
        ...(f.prospect !== undefined && { prospect: f.prospect }),
      })
      break
    }
    case 'project.move': {
      const p = project(cmd.id)
      put('project', p, { ...p, position: positionBefore(plan.projects, p.id, cmd.beforeId) })
      break
    }
    case 'project.addOpenLine': {
      const p = project(cmd.id)
      if (p.openLines >= PLAN_LIMITS.openLines) refuse(`A project can have up to ${PLAN_LIMITS.openLines} “not assigned yet” lines.`)
      put('project', p, { ...p, openLines: p.openLines + 1 })
      break
    }
    case 'project.removeOpenLine': {
      const p = project(cmd.id)
      if (p.openLines <= 1 || cmd.slot < 0 || cmd.slot >= p.openLines) refuse('A project keeps at least one “not assigned yet” line.')
      if (plan.blocks.some((b) => b.projectId === p.id && b.personId === null && b.slot === cmd.slot))
        refuse('That line has time on it. Move or remove it first.')
      // The lines after it move up one.
      for (const b of plan.blocks) if (b.projectId === p.id && b.personId === null && b.slot > cmd.slot) put('block', b, { ...b, slot: b.slot - 1 })
      put('project', p, { ...p, openLines: p.openLines - 1 })
      break
    }
    case 'project.remove': {
      const p = project(cmd.id)
      for (const b of plan.blocks) if (b.projectId === p.id) drop('block', b)
      for (const l of plan.lines) if (l.projectId === p.id) drop('line', l)
      drop('project', p)
      break
    }

    case 'person.add': {
      if (plan.people.length >= PLAN_LIMITS.people) refuse(`A plan can have up to ${PLAN_LIMITS.people} people.`)
      const id = fresh('people', cmd.id ?? ctx.newId())
      if (cmd.roleId) role(cmd.roleId)
      put('person', null, {
        id,
        userId: null,
        name: cleanName(cmd.name, PLAN_LIMITS.name, 'person'),
        roleId: cmd.roleId ?? null,
        hoursPerDay: cleanHours(cmd.hoursPerDay ?? 8),
        position: null,
      })
      break
    }
    case 'person.update': {
      const p = person(cmd.id)
      const f = cmd.fields
      if (f.name !== undefined && p.userId) refuse('Their name comes from their Kanbanto account.')
      if (f.roleId) role(f.roleId)
      put('person', p, {
        ...p,
        ...(f.name !== undefined && { name: cleanName(f.name, PLAN_LIMITS.name, 'person') }),
        ...(f.roleId !== undefined && { roleId: f.roleId }),
        ...(f.hoursPerDay !== undefined && { hoursPerDay: cleanHours(f.hoursPerDay) }),
      })
      break
    }
    case 'person.move': {
      const p = person(cmd.id)
      const order = peopleInOrder(plan).filter((x) => x.id !== p.id)
      const at = cmd.beforeId ? order.findIndex((x) => x.id === cmd.beforeId) : order.length
      if (at < 0) refuse('That person is no longer in the plan.')
      order.splice(at, 0, p)
      // Everyone gets a place the first time (until then they're in role-then-name order); after that, only the one moved.
      if (order.every((x) => x.id === p.id || x.position !== null)) {
        put('person', p, { ...p, position: positionBetween(order[at - 1]?.position ?? null, order[at + 1]?.position ?? null) })
      } else {
        let last: string | null = null
        for (const x of order) {
          last = positionBetween(last, null)
          put('person', x, { ...x, position: last })
        }
      }
      break
    }
    case 'person.merge': {
      const from = person(cmd.id)
      const into = person(cmd.into)
      if (from.userId) refuse('Only someone added by name can be linked to an account.')
      if (!into.userId || from.id === into.id) refuse('Pick someone in the workspace.')
      // (Checked against the plan as it is: their own blocks on a project already keep clear of each other.)
      for (const b of plan.blocks.filter((x) => x.personId === from.id)) {
        const moved = { ...b, personId: into.id }
        const p = project(b.projectId)
        if (overlapsOnLine(plan, b.projectId, into.id, toDay(b.start), toDay(b.end), b.id))
          refuse(`${from.name}'s time on ${p.name} overlaps ${into.name}'s there. Move one of them first.`)
        out.push({ entity: 'block', id: b.id, before: b, after: stamp(b, moved, now) } as PlanChange)
      }
      for (const l of plan.lines.filter((x) => x.personId === from.id)) {
        drop('line', l)
        if (!plan.lines.some((x) => x.personId === into.id && x.projectId === l.projectId))
          put('line', null, { id: ctx.newId(), projectId: l.projectId, personId: into.id })
      }
      if (!into.roleId && from.roleId) put('person', into, { ...into, roleId: from.roleId })
      drop('person', from)
      break
    }
    case 'person.remove': {
      const p = person(cmd.id)
      if (p.userId && ctx.members.has(p.userId)) refuse('People in the workspace stay in its plan. Remove them from the workspace first.')
      // Their time goes to the first "not assigned yet" line it fits on, or to a new one.
      let next = plan
      for (const b of plan.blocks.filter((x) => x.personId === p.id)) {
        const pr = next.projects.find((x) => x.id === b.projectId)!
        let slot = 0
        while (slot < pr.openLines && overlapsOnLine(next, b.projectId, null, toDay(b.start), toDay(b.end), b.id, slot)) slot++
        const cs: PlanChange[] = []
        if (slot === pr.openLines)
          cs.push({ entity: 'project', id: pr.id, before: pr, after: stamp(pr, { ...pr, openLines: pr.openLines + 1 }, now) })
        cs.push({ entity: 'block', id: b.id, before: b, after: stamp(b, { ...b, personId: null, slot }, now) })
        out.push(...cs)
        next = applyPlanChanges(next, cs)
      }
      for (const l of plan.lines) if (l.personId === p.id) drop('line', l)
      drop('person', p)
      break
    }

    case 'line.add': {
      project(cmd.projectId)
      person(cmd.personId)
      if (plan.lines.some((l) => l.projectId === cmd.projectId && l.personId === cmd.personId)) break
      if (plan.lines.length >= PLAN_LIMITS.lines) refuse('This plan has as many people on projects as it can hold.')
      put('line', null, { id: fresh('lines', cmd.id ?? ctx.newId()), projectId: cmd.projectId, personId: cmd.personId })
      break
    }
    case 'line.remove': {
      const l = plan.lines.find((x) => x.projectId === cmd.projectId && x.personId === cmd.personId)
      if (l) drop('line', l)
      break
    }

    case 'role.add': {
      if (plan.roles.length >= PLAN_LIMITS.roles) refuse(`A plan can have up to ${PLAN_LIMITS.roles} roles.`)
      const name = cleanName(cmd.name, PLAN_LIMITS.role, 'role')
      if (plan.roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) refuse(`There's already a role called ${name}.`)
      put('role', null, { id: fresh('roles', cmd.id ?? ctx.newId()), name, position: positionBetween(lastPosition(plan.roles), null) })
      break
    }
    case 'role.update': {
      const r = role(cmd.id)
      const name = cleanName(cmd.name, PLAN_LIMITS.role, 'role')
      if (plan.roles.some((x) => x.id !== r.id && x.name.toLowerCase() === name.toLowerCase())) refuse(`There's already a role called ${name}.`)
      put('role', r, { ...r, name })
      break
    }
    case 'role.move': {
      const r = role(cmd.id)
      put('role', r, { ...r, position: positionBefore(plan.roles, r.id, cmd.beforeId) })
      break
    }
    case 'role.remove': {
      const r = role(cmd.id)
      for (const p of plan.people) if (p.roleId === r.id) put('person', p, { ...p, roleId: null })
      drop('role', r)
      break
    }

    case 'plan.restore':
      return restore(plan, cmd.changes, ctx, checked)
  }
  return out
}

/**
 * Puts records back, checked so the plan stays whole: what restored records point at must exist, nothing may be left
 * pointing at a record that's removed, and blocks on a line still mustn't overlap.
 */
function restore(
  plan: PlanData,
  changes: PlanChange[],
  ctx: PlanContext,
  checked: (b: Omit<PlanBlock, 'createdAt' | 'updatedAt' | 'version'>, on?: PlanData) => unknown,
): PlanChange[] {
  const out: PlanChange[] = []
  for (const c of changes) {
    const cur = currentPlanRecord(plan, c.entity, c.id)
    if ((cur?.version ?? null) !== (c.before?.version ?? null)) refuse('Someone changed this in the meantime, so it can’t be undone.')
    const after = c.after && { ...c.after, id: c.id, updatedAt: ctx.now, version: cur ? cur.version + 1 : c.after.version }
    out.push({ entity: c.entity, id: c.id, before: cur, after } as PlanChange)
  }
  const next = applyPlanChanges(plan, out)
  // Undo can't make a plan bigger than adding to it could.
  for (const list of ['projects', 'people', 'roles', 'blocks', 'lines'] as const)
    if (next[list].length > PLAN_LIMITS[list] && next[list].length > plan[list].length)
      refuse('That would make the plan too big, so it can’t be undone.')
  const has = (list: { id: string }[], id: string | null) => id === null || list.some((x) => x.id === id)
  for (const c of out) {
    if (c.entity !== 'project' || !c.after) continue
    if (next.blocks.some((b) => b.projectId === c.id && b.personId === null && b.slot >= c.after!.openLines))
      refuse('That project’s “not assigned yet” lines have time on them now, so it can’t be undone.')
    if (c.after.boardId && next.projects.some((p) => p.id !== c.id && p.boardId === c.after!.boardId))
      refuse('That board is linked to another project now, so it can’t be undone.')
  }
  for (const [i, c] of out.entries()) {
    if (!c.after) continue
    if (c.entity === 'block') checked(c.after, next)
    if (c.entity === 'line' && (!has(next.projects, c.after.projectId) || !has(next.people, c.after.personId)))
      refuse('That project or person is no longer in the plan, so it can’t be undone.')
    // A role that's gone since is dropped rather than refusing the whole undo.
    if (c.entity === 'person') {
      // Who an account is can't change by undo, and an account is in the plan once.
      if (c.before && c.after.userId !== c.before.userId) refuse('That can’t be undone.')
      // Someone put back with an account has to be in the workspace: undo can't tie the plan to an outsider.
      if (!c.before && c.after.userId && !ctx.members.has(c.after.userId)) refuse('They’re no longer in the workspace, so that can’t be undone.')
      if (c.after.userId && next.people.some((p) => p.id !== c.id && p.userId === c.after!.userId)) refuse('They’re already in the plan.')
      if (!has(next.roles, c.after.roleId)) out[i] = { ...c, after: { ...c.after, roleId: null } }
    }
  }
  for (const c of out) {
    if (c.after) continue
    if (c.entity === 'project' && (next.blocks.some((b) => b.projectId === c.id) || next.lines.some((l) => l.projectId === c.id)))
      refuse('That project has time on it now, so it can’t be undone.')
    if (c.entity === 'person' && (next.blocks.some((b) => b.personId === c.id) || next.lines.some((l) => l.personId === c.id)))
      refuse('That person has time in the plan now, so it can’t be undone.')
    if (c.entity === 'person' && c.before?.userId && ctx.members.has(c.before.userId)) refuse('People in the workspace stay in its plan.')
    if (c.entity === 'role' && next.people.some((p) => p.roleId === c.id)) refuse('Someone has that role now, so it can’t be undone.')
  }
  return out
}
