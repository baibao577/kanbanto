import { dayParts, isWeekend, mondayOf, toDay, todayDay } from '@kanbanto/model/dates'
import {
  bookedUntil,
  peopleInOrder,
  personFacts,
  projectFacts,
  spanOf,
  sumManDays,
  type PersonFacts,
  type PlanBlock,
  type PlanData,
  type PlanPerson,
  type PlanProject,
  type PlanRole,
  type ProjectActuals,
  type ProjectFacts,
} from '@kanbanto/model/planning'
import { comparePositions } from '@kanbanto/model/position'

/**
 * What the planning sheet shows, row by row, worked out from the plan (no drawing here). By project: each project, a
 * line per person on it, a "not assigned yet" line, and "+ add a person". By person: each person, a line per project
 * they're on, and "+ add to a project"; then time nobody has yet. A line is where blocks sit, are added and dropped.
 */
export type SheetRow =
  | {
      kind: 'project'
      key: string
      project: PlanProject
      facts: ProjectFacts
      collapsed: boolean
      /** Time logged on its board (when it's linked and there is some), and man-days booked until today. */
      actual: ProjectActuals | null
      booked: number
    }
  | { kind: 'person'; key: string; person: PlanPerson; role: PlanRole | null; facts: PersonFacts; left: boolean; collapsed: boolean }
  | {
      kind: 'line'
      key: string
      projectId: string
      personId: string | null
      /** Which "not assigned yet" line (personId null), from 0. */
      slot: number
      /** How many "not assigned yet" lines its project has (to number them, and to take an empty one away). */
      openLines: number
      /** What the line is labelled with: the person (by project), the project (by person). */
      label: 'person' | 'project'
      blocks: PlanBlock[]
      md: number
      /** Someone put on the project with no time yet (their line can be taken away). */
      empty: boolean
      /** What they logged on the project's board, and the man-days booked on this line until today. */
      logged: { minutes: number; md: number } | null
      booked: number
    }
  | { kind: 'add-person'; key: string; projectId: string; options: PlanPerson[] }
  | { kind: 'add-project'; key: string; personId: string; options: PlanProject[] }
  | { kind: 'heading'; key: string; title: string; detail: string; toggle?: 'finished'; open?: boolean }

export const ROW_HEIGHT: Record<SheetRow['kind'], number> = { project: 52, person: 52, line: 36, 'add-person': 34, 'add-project': 34, heading: 40 }

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
const firstStart = (blocks: PlanBlock[]) => Math.min(...blocks.map((b) => toDay(b.start)))

/** Logged time and today, for the figures on lines. */
interface Actuals {
  byProject: Record<string, ProjectActuals>
  today: number
}

/**
 * People on a project: those with time on it (earliest first), then those put on it with none yet, or who logged time
 * on its board without being booked.
 */
function peopleOn(plan: PlanData, projectId: string, actuals?: Actuals) {
  const blocks = plan.blocks.filter((b) => b.projectId === projectId && b.personId)
  const withTime = [...new Set(blocks.map((b) => b.personId!))]
    .map((id) => ({ id, first: firstStart(blocks.filter((b) => b.personId === id)) }))
    .sort((a, b) => a.first - b.first)
    .map((x) => x.id)
  const logged = Object.keys(actuals?.byProject[projectId]?.people ?? {})
  const added = plan.people
    .filter((p) => !withTime.includes(p.id) && (plan.lines.some((l) => l.projectId === projectId && l.personId === p.id) || logged.includes(p.id)))
    .sort(byName)
    .map((p) => p.id)
  return [...withTime.filter((id) => plan.people.some((p) => p.id === id)), ...added]
}

/** Projects a person is on, the same way round. */
function projectsOf(plan: PlanData, personId: string, actuals?: Actuals) {
  const blocks = plan.blocks.filter((b) => b.personId === personId)
  const withTime = [...new Set(blocks.map((b) => b.projectId))]
    .map((id) => ({ id, first: firstStart(blocks.filter((b) => b.projectId === id)) }))
    .sort((a, b) => a.first - b.first)
    .map((x) => x.id)
  const added = plan.projects
    .filter(
      (p) =>
        !withTime.includes(p.id) &&
        (plan.lines.some((l) => l.personId === personId && l.projectId === p.id) || !!actuals?.byProject[p.id]?.people[personId]),
    )
    .map((p) => p.id)
  return [...withTime, ...added].filter((id) => plan.projects.some((p) => p.id === id))
}

function line(plan: PlanData, projectId: string, personId: string | null, label: 'person' | 'project', slot = 0, actuals?: Actuals): SheetRow {
  const blocks = plan.blocks
    .filter((b) => b.projectId === projectId && b.personId === personId && (personId !== null || b.slot === slot))
    .sort((a, b) => (a.start < b.start ? -1 : 1))
  return {
    kind: 'line',
    key: `line:${projectId}:${personId ?? `-${slot}`}:${label}`,
    projectId,
    personId,
    slot,
    openLines: plan.projects.find((p) => p.id === projectId)?.openLines ?? 1,
    label,
    blocks,
    md: sumManDays(blocks),
    empty: !blocks.length,
    logged: (personId && actuals?.byProject[projectId]?.people[personId]) || null,
    booked: actuals ? bookedUntil(blocks, actuals.today) : 0,
  }
}

/** Groups folded to their first row (`project:<id>`, `person:<id>`). */
export type Collapsed = ReadonlySet<string>

export function rowsByProject(
  plan: PlanData,
  opts: { canEdit: boolean; showFinished: boolean; collapsed?: Collapsed; actuals?: Record<string, ProjectActuals>; today?: number },
): SheetRow[] {
  const rows: SheetRow[] = []
  const actuals = { byProject: opts.actuals ?? {}, today: opts.today ?? todayDay() }
  const projectRows = (p: PlanProject) => {
    const key = `project:${p.id}`
    const collapsed = !!opts.collapsed?.has(key)
    rows.push({
      kind: 'project',
      key,
      project: p,
      facts: projectFacts(plan, p.id),
      collapsed,
      actual: actuals.byProject[p.id] ?? null,
      booked: bookedUntil(
        plan.blocks.filter((b) => b.projectId === p.id),
        actuals.today,
      ),
    })
    if (collapsed) return
    const people = peopleOn(plan, p.id, actuals)
    for (const id of people) rows.push(line(plan, p.id, id, 'person', 0, actuals))
    for (let slot = 0; slot < p.openLines; slot++) rows.push(line(plan, p.id, null, 'person', slot, actuals))
    if (opts.canEdit) {
      const options = plan.people.filter((x) => !people.includes(x.id)).sort(byName)
      rows.push({ kind: 'add-person', key: `add-person:${p.id}`, projectId: p.id, options })
    }
  }
  const open = plan.projects.filter((p) => !p.finishedAt && !p.prospect)
  const prospects = plan.projects.filter((p) => !p.finishedAt && p.prospect)
  const finished = plan.projects.filter((p) => p.finishedAt)
  for (const p of open) projectRows(p)
  // Work that might not happen, apart from what's going ahead.
  if (prospects.length) {
    rows.push({
      kind: 'heading',
      key: 'prospects',
      title: `Prospects (${prospects.length})`,
      detail: 'Might not happen. Their time is shown dashed and doesn’t count toward people’s Over or Fit.',
    })
    for (const p of prospects) projectRows(p)
  }
  if (finished.length) {
    rows.push({
      kind: 'heading',
      key: 'finished',
      title: `Finished (${finished.length})`,
      detail: opts.showFinished ? 'Their time still counts toward people’s load.' : 'Folded away. Their time still counts toward people’s load.',
      toggle: 'finished',
      open: opts.showFinished,
    })
    if (opts.showFinished) for (const p of finished) projectRows(p)
  }
  return rows
}

/** People in the plan's order (see peopleInOrder). */
export const sortedPeople = peopleInOrder

export function rowsByPerson(
  plan: PlanData,
  opts: {
    canEdit: boolean
    today: number
    memberIds: string[]
    roleId: string | null
    collapsed?: Collapsed
    actuals?: Record<string, ProjectActuals>
  },
): SheetRow[] {
  const rows: SheetRow[] = []
  const actuals = { byProject: opts.actuals ?? {}, today: opts.today }
  const roles = new Map(plan.roles.map((r) => [r.id, r]))
  for (const person of sortedPeople(plan)) {
    if (opts.roleId && person.roleId !== opts.roleId) continue
    const key = `person:${person.id}`
    const collapsed = !!opts.collapsed?.has(key)
    rows.push({
      kind: 'person',
      key,
      person,
      role: (person.roleId && roles.get(person.roleId)) || null,
      facts: personFacts(plan, person.id, opts.today),
      left: !!person.userId && !opts.memberIds.includes(person.userId),
      collapsed,
    })
    if (collapsed) continue
    const projects = projectsOf(plan, person.id, actuals)
    for (const id of projects) rows.push(line(plan, id, person.id, 'project', 0, actuals))
    if (opts.canEdit) {
      const options = plan.projects.filter((p) => !p.finishedAt && !projects.includes(p.id)).sort((a, b) => comparePositions(a.position, b.position))
      if (options.length) rows.push({ kind: 'add-project', key: `add-project:${person.id}`, personId: person.id, options })
    }
  }
  const open = plan.blocks.filter((b) => !b.personId)
  if (open.length) {
    rows.push({
      kind: 'heading',
      key: 'open',
      title: 'Not assigned yet',
      detail: `${fmtMd(sumManDays(open))} man-days. Drag them onto someone’s line to assign them.`,
    })
    for (const p of plan.projects)
      for (let slot = 0; slot < p.openLines; slot++)
        if (open.some((b) => b.projectId === p.id && b.slot === slot)) rows.push(line(plan, p.id, null, 'project', slot, actuals))
  }
  return rows
}

// ── The time axis ─────────────────────────────────────────────────────────────

export type Zoom = 'days' | 'weeks' | 'months'

const DAY_W: Record<Zoom, [wide: number, narrow: number]> = { days: [28, 24], weeks: [8, 6], months: [4, 3] }

/** Pixels per day. */
export const dayWidth = (zoom: Zoom, narrow: boolean) => DAY_W[zoom][narrow ? 1 : 0]

/** How far the sheet reaches either side of today: three years. */
export const REACH = 3 * 366

/**
 * The days the sheet spans: two weeks before today (or the earliest block) to half a year after today (or a month
 * past the last block), plus `more` weeks either side (it grows as you scroll to an end), Monday to Sunday, at most
 * three years either side of today.
 */
export function sheetRange(plan: PlanData, today: number, more = { before: 0, after: 0 }) {
  const spans = plan.blocks.map(spanOf)
  const lo = Math.max(today - REACH, Math.min(today, ...spans.map((s) => s.start)) - more.before * 7)
  const hi = Math.min(today + REACH, Math.max(today + 26 * 7, ...spans.map((s) => s.end + 28)) + more.after * 7)
  const start = mondayOf(lo) - 14
  return { start, end: mondayOf(hi) + 6 }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Header marks: months, and either Mondays (weeks) or every day (days); in months, years and months. The month (or
 * year) the sheet starts in is only named when there's room before the next one (`minDays`); in weeks and days, the
 * first month named carries the year.
 */
export function ticks(start: number, end: number, zoom: Zoom, today: number, minDays = 0) {
  const months: { day: number; label: string }[] = []
  const minor: { day: number; label: string; weekend: boolean; today: boolean }[] = []
  const now = dayParts(today)
  const top = (d: number, label: (first: boolean) => string) => {
    if (months.length === 1 && months[0].day === start && d - start < minDays) months.pop()
    months.push({ day: d, label: label(!months.length) })
  }
  for (let d = start; d <= end; d++) {
    const p = dayParts(d)
    if (zoom === 'months') {
      if (d === start || (p.month === 0 && p.date === 1)) top(d, () => String(p.year))
      if (p.date === 1) minor.push({ day: d, label: MONTHS[p.month], weekend: false, today: p.year === now.year && p.month === now.month })
      continue
    }
    if (d === start || p.date === 1) top(d, (first) => `${MONTHS[p.month]}${p.month === 0 || first ? ` ${p.year}` : ''}`)
    if (zoom === 'days') minor.push({ day: d, label: String(p.date), weekend: isWeekend(d), today: d === today })
    else if (p.weekday === 1) minor.push({ day: d, label: String(p.date), weekend: false, today: d <= today && today < d + 7 })
  }
  return { months, minor }
}

export const fmtMd = (x: number) => (Math.round(x * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })
