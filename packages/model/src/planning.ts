import type { ColorName } from './colors'
import { mondayOf, toDay, weekdayOf } from './dates'
import type { Meta } from './types'

/**
 * A workspace's plan of who works on which project, for how long and how much of their time (resource planning).
 * It stands on its own, apart from the boards: projects with a budget in man-days, people with a role, and blocks of
 * time that put a person (or nobody yet) on a project between two days at 25, 50, 75 or 100% of their time.
 *
 * - A man-day is one working day of a person, whatever their hours: a block is worth its working days × its share.
 * - A line is one person (or nobody) on one project. Blocks on a line never overlap; a person on several projects at
 *   once is how they go over 100%, and that's shown, not refused.
 * - Days are stored as "2026-10-15" and handled as day numbers (see dates.ts).
 */

export const PERCENTS = [25, 50, 75, 100] as const
export type Percent = (typeof PERCENTS)[number]

/** Working weekdays, 0 = Sunday … 6 = Saturday. */
export type WorkWeek = readonly number[]
export const WORK_WEEK: WorkWeek = [1, 2, 3, 4, 5]

/** The roles a new workspace's plan starts with (planners can change them). */
export const DEFAULT_ROLES = ['SE', 'DE', 'SA', 'BA'] as const

export interface PlanRole extends Meta {
  id: string
  name: string
  /** Position key (see position.ts); roles are listed in this order. */
  position: string
}

export interface PlanPerson extends Meta {
  id: string
  /** Their Kanbanto account, for workspace members; null for someone added by name (or whose account is gone). */
  userId: string | null
  name: string
  roleId: string | null
  /** For reference: a man-day is one of their working days, however long. */
  hoursPerDay: number
}

export interface PlanProject extends Meta {
  id: string
  name: string
  client: string
  /** The budget in man-days; null when there's no plan for it yet. */
  plannedMd: number | null
  color: ColorName
  position: string
  /** Finished projects are folded away; their blocks still count. */
  finishedAt: string | null
  /** How many "not assigned yet" lines it has (at least one): one for each need nobody is chosen for yet. */
  openLines: number
}

/** Someone put on a project with no time yet, so their line is there to add blocks to. */
export interface PlanLine extends Meta {
  id: string
  projectId: string
  personId: string
}

export interface PlanBlock extends Meta {
  id: string
  projectId: string
  /** null: not assigned to anyone yet. */
  personId: string | null
  /** Which of its project's "not assigned yet" lines it's on (0 for someone's time). */
  slot: number
  start: string
  end: string
  pct: Percent
}

export interface PlanData {
  roles: PlanRole[]
  people: PlanPerson[]
  projects: PlanProject[]
  lines: PlanLine[]
  blocks: PlanBlock[]
}

export const emptyPlan = (): PlanData => ({ roles: [], people: [], projects: [], lines: [], blocks: [] })

// ── Working days ──────────────────────────────────────────────────────────────

export const isWorkDay = (day: number, week: WorkWeek = WORK_WEEK) => week.includes(weekdayOf(day))

/** Working days from `start` to `end`, both included. */
export function workDays(start: number, end: number, week: WorkWeek = WORK_WEEK): number {
  if (end < start) return 0
  // Whole weeks at once, then the days left over.
  const weeks = Math.floor((end - start + 1) / 7)
  let n = weeks * week.length
  for (let d = start + weeks * 7; d <= end; d++) if (isWorkDay(d, week)) n++
  return n
}

export function nextWorkDay(day: number, week: WorkWeek = WORK_WEEK): number {
  if (!week.length) return day
  while (!isWorkDay(day, week)) day++
  return day
}

export function prevWorkDay(day: number, week: WorkWeek = WORK_WEEK): number {
  if (!week.length) return day
  while (!isWorkDay(day, week)) day--
  return day
}

/**
 * The last day of a block that starts on `start` and is worth `md` man-days at `pct`% of someone's time: as many
 * working days as that takes, rounded up to a whole day. Null if it can't be (nothing to fill, or over ten years).
 */
export function endForManDays(start: number, md: number, pct: number, week: WorkWeek = WORK_WEEK): number | null {
  if (!(md > 0) || !(pct > 0) || !week.length) return null
  const days = Math.ceil(md / (pct / 100) - 1e-9)
  if (days > 2600) return null
  let d = nextWorkDay(start, week)
  for (let n = 1; n < days;) if (isWorkDay(++d, week)) n++
  return d
}

// ── Sums ──────────────────────────────────────────────────────────────────────

/** A block with its days as numbers. */
export interface Span {
  start: number
  end: number
  pct: number
}

export const spanOf = (b: Pick<PlanBlock, 'start' | 'end' | 'pct'>): Span => ({ start: toDay(b.start), end: toDay(b.end), pct: b.pct })

/** What a block is worth: its working days × its share of a day. */
export const manDays = (b: Pick<PlanBlock, 'start' | 'end' | 'pct'>, week: WorkWeek = WORK_WEEK) =>
  (workDays(toDay(b.start), toDay(b.end), week) * b.pct) / 100

export const sumManDays = (blocks: Pick<PlanBlock, 'start' | 'end' | 'pct'>[], week: WorkWeek = WORK_WEEK) =>
  blocks.reduce((sum, b) => sum + manDays(b, week), 0)

/** How a project's scheduled man-days compare with its plan. Fit: within half a man-day. */
export type PlanStatus = 'none' | 'under' | 'fit' | 'over'

export interface ProjectFacts {
  /** Man-days on the project, assigned or not. */
  scheduled: number
  /** The part nobody has yet. */
  unassigned: number
  /** scheduled − planned (0 without a plan). */
  diff: number
  status: PlanStatus
  /** The first and last day of its blocks (null without any). */
  start: number | null
  end: number | null
}

export function projectFacts(plan: PlanData, projectId: string, week: WorkWeek = WORK_WEEK): ProjectFacts {
  const project = plan.projects.find((p) => p.id === projectId)
  const blocks = plan.blocks.filter((b) => b.projectId === projectId)
  const scheduled = sumManDays(blocks, week)
  const unassigned = sumManDays(
    blocks.filter((b) => !b.personId),
    week,
  )
  const planned = project?.plannedMd ?? null
  const diff = planned === null ? 0 : scheduled - planned
  const status: PlanStatus = planned === null ? 'none' : Math.abs(diff) < 0.5 ? 'fit' : diff < 0 ? 'under' : 'over'
  const spans = blocks.map(spanOf)
  return {
    scheduled,
    unassigned,
    diff,
    status,
    start: spans.length ? Math.min(...spans.map((s) => s.start)) : null,
    end: spans.length ? Math.max(...spans.map((s) => s.end)) : null,
  }
}

/** A person's share of a day across all their projects (100 = fully booked). */
export const loadOn = (spans: Span[], day: number) => spans.reduce((t, s) => (s.start <= day && day <= s.end ? t + s.pct : t), 0)

export interface PersonFacts {
  /** Their load on the next working day from `today`. */
  nowLoad: number
  /** Their busiest working day from `today` on. */
  peak: number
  /** The first stretch above 100% from `today` on (working days), if any. */
  overFrom: number | null
  overTo: number | null
  /** The first working day after their last block, when it's still ahead; null when nothing is booked ahead. */
  freeFrom: number | null
  /** Over: above 100% somewhere ahead. Fit: fully booked now. Under: room now. */
  status: 'under' | 'fit' | 'over'
}

export function personFacts(plan: PlanData, personId: string, today: number, week: WorkWeek = WORK_WEEK): PersonFacts {
  const spans = plan.blocks.filter((b) => b.personId === personId).map(spanOf)
  const first = nextWorkDay(today, week)
  const last = spans.length ? Math.max(...spans.map((s) => s.end)) : -Infinity
  let peak = 0
  let overFrom: number | null = null
  let overTo: number | null = null
  let done = false
  for (let d = first; d <= last; d++) {
    if (!isWorkDay(d, week)) continue
    const l = loadOn(spans, d)
    if (l > peak) peak = l
    if (done) continue
    if (l > 100) {
      overFrom ??= d
      overTo = d
    } else if (overFrom !== null) done = true
  }
  const nowLoad = loadOn(spans, first)
  return {
    nowLoad,
    peak,
    overFrom,
    overTo,
    freeFrom: last >= today ? nextWorkDay(last + 1, week) : null,
    status: peak > 100 ? 'over' : nowLoad === 100 ? 'fit' : 'under',
  }
}

// ── Lines ─────────────────────────────────────────────────────────────────────

/** The blocks on a line: one person on one project, or one of its "not assigned yet" lines (`personId` null, `slot`). */
export const lineBlocks = (plan: PlanData, projectId: string, personId: string | null, except?: string, slot = 0) =>
  plan.blocks.filter((b) => b.projectId === projectId && b.personId === personId && (personId !== null || b.slot === slot) && b.id !== except)

/** Whether `start`..`end` would overlap another block on that line. */
export function overlapsOnLine(plan: PlanData, projectId: string, personId: string | null, start: number, end: number, except?: string, slot = 0) {
  return lineBlocks(plan, projectId, personId, except, slot).some((b) => toDay(b.start) <= end && start <= toDay(b.end))
}

/** How long a block added by pointing at a day is: Monday to Friday of that week, or five working days from it. */
export type AddSize = 'week' | 'days'

/**
 * The block to add where someone points: the usual length, trimmed to the free space around `day` on that line.
 * Null when there's no room (the day is taken, or no working day is free around it).
 */
export function freeRangeAt(
  plan: PlanData,
  projectId: string,
  personId: string | null,
  day: number,
  size: AddSize,
  slot = 0,
  week: WorkWeek = WORK_WEEK,
) {
  const spans = lineBlocks(plan, projectId, personId, undefined, slot).map(spanOf)
  if (!week.length || spans.some((s) => s.start <= day && day <= s.end)) return null
  let lo = -Infinity
  let hi = Infinity
  for (const s of spans) {
    if (s.end < day) lo = Math.max(lo, s.end + 1)
    if (s.start > day) hi = Math.min(hi, s.start - 1)
  }
  let start: number
  let end: number
  if (size === 'week') {
    start = mondayOf(day)
    end = start + 4
  } else {
    start = nextWorkDay(day, week)
    end = start
    for (let n = 1; n < 5;) if (isWorkDay(++end, week)) n++
  }
  start = Math.max(start, lo)
  end = Math.min(end, hi)
  return start <= end && workDays(start, end, week) > 0 ? { start, end } : null
}

/**
 * Where a block can be split at `day` (the first day of its second part): both parts must keep a working day.
 * The first part then ends on the working day before.
 */
export function canSplit(b: Pick<PlanBlock, 'start' | 'end'>, day: number, week: WorkWeek = WORK_WEEK) {
  const s = toDay(b.start)
  const e = toDay(b.end)
  return day > s && day <= e && workDays(s, day - 1, week) > 0 && workDays(day, e, week) > 0
}
