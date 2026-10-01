import { lastActivity } from './age'
import { hasTime, toDay, todayDay } from './dates'
import { isLeaf, type TaskIndex } from './indexer'
import type { BoardData, StatusColumn, Task } from './types'

/**
 * A board at a glance: how fast cards get done, how many come in and go out, where the open ones sit and which have
 * been around longest. Nothing here knows about React.
 *
 * It counts cards: tasks without subtasks (a parent's status follows its subtasks). Archived cards count as made, and
 * as done when they were archived as completed.
 *
 * When a card was done isn't stored. For a card in a done list it's taken to be its last real change (moving it there,
 * usually: an edit made afterwards moves it later); for an archived one, when it was archived.
 */

const DAY_MS = 86_400_000

/** The periods to look back over, in days. */
export const STAT_PERIODS = [7, 30, 90] as const

/** How long cards took to get done, from quick to slow: the top of each bucket in days (the last has none). */
export const DONE_BUCKETS = [
  { label: 'Same day', under: 1 },
  { label: '1–3 days', under: 3 },
  { label: 'A week', under: 7 },
  { label: 'A month', under: 30 },
  { label: 'Longer', under: Infinity },
] as const

/** Weeks of history in the "done each day" grid. */
export const HEAT_WEEKS = 20

export interface StatCard {
  id: string
  title: string
  /** Whole days: how old it is, or how long since anything happened on it. */
  days: number
  /** The list it's in. */
  list: string
}

export interface BoardStats {
  /** The period, in days, ending today; `previous` numbers are for the same number of days before it. */
  days: number
  /** Open cards now (not in a done list). */
  open: number
  inProgress: number
  overdue: number
  /** Due in the next 7 days, not overdue. */
  dueSoon: number
  created: number
  createdBefore: number
  done: number
  doneBefore: number
  /** Median time from made to done for cards done in the period, in ms (null: none were done). */
  timeToDone: number | null
  timeToDoneBefore: number | null
  /** The quickest and slowest of them, in ms. */
  quickest: number | null
  slowest: number | null
  /** How many of them fall in each of DONE_BUCKETS. */
  buckets: number[]
  /** Cards made and done over the period: one entry per day, or per week for a long period. */
  flow: { from: number; to: number; created: number; done: number }[]
  /** Open cards per list (lists that aren't for finished work), in board order. */
  lists: { column: StatusColumn; count: number }[]
  /** The open cards made longest ago, and the ones nothing has happened on for longest. */
  oldest: StatCard[]
  untouched: StatCard[]
  /** Cards done on each day (a day number each), from a Monday HEAT_WEEKS weeks back up to today. */
  heat: { day: number; count: number }[]
}

const median = (sorted: number[]) => (sorted.length ? (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2 : null)

export function boardStats(
  data: BoardData,
  idx: TaskIndex,
  opts: { days: number; today?: number; lastComment?: Record<string, string> },
): BoardStats {
  const today = opts.today ?? todayDay()
  const { days } = opts
  const from = today - days + 1
  const before = from - days

  // Every card, with the day it was made and (if it is) the moment it was done.
  const cards: { made: number; madeAt: number; doneAt: number | null }[] = []
  const open: Task[] = []
  for (const t of Object.values(data.tasks)) {
    if (!isLeaf(idx, t.id)) continue
    const isDone = idx.category.get(t.id) === 'done'
    cards.push({ made: toDay(t.createdAt), madeAt: Date.parse(t.createdAt), doneAt: isDone ? Date.parse(t.activeAt ?? t.updatedAt) : null })
    if (!isDone) open.push(t)
  }
  const archived = Object.values(data.archived ?? {})
  const archivedParents = new Set(archived.map((t) => t.parentId))
  for (const t of archived) {
    if (archivedParents.has(t.id)) continue
    cards.push({
      made: toDay(t.createdAt),
      madeAt: Date.parse(t.createdAt),
      doneAt: t.archivedDone && t.archivedAt ? Date.parse(t.archivedAt) : null,
    })
  }
  const dayOf = (ms: number) => toDay(new Date(ms).toISOString())
  const finished = cards.filter((c) => c.doneAt !== null).map((c) => ({ ...c, doneDay: dayOf(c.doneAt!), took: Math.max(0, c.doneAt! - c.madeAt) }))

  const within = (day: number, a: number, b: number) => day >= a && day <= b
  const tookIn = (a: number, b: number) =>
    finished
      .filter((c) => within(c.doneDay, a, b))
      .map((c) => c.took)
      .sort((x, y) => x - y)
  const took = tookIn(from, today)
  const buckets = DONE_BUCKETS.map(() => 0)
  for (const ms of took) buckets[DONE_BUCKETS.findIndex((b) => ms / DAY_MS < b.under)]++

  // Day by day up to a month; week by week (ending today) beyond.
  const step = days > 31 ? 7 : 1
  const flow: BoardStats['flow'] = []
  for (let to = today; to >= from; to -= step) flow.unshift({ from: Math.max(from, to - step + 1), to, created: 0, done: 0 })
  const slot = (day: number) => flow.find((f) => within(day, f.from, f.to))
  for (const c of cards) {
    const made = slot(c.made)
    if (made) made.created++
  }
  for (const c of finished) {
    const done = slot(c.doneDay)
    if (done) done.done++
  }

  const card = (t: Task, n: number): StatCard => ({ id: t.id, title: t.title, days: n, list: idx.colById.get(idx.status.get(t.id)!)?.name ?? '' })
  const oldest = [...open]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, 5)
    .map((t) => card(t, today - toDay(t.createdAt)))
  const touched = (t: Task) => lastActivity(idx, t.id, opts.lastComment)
  const untouched = [...open]
    .sort((a, b) => touched(a) - touched(b))
    .slice(0, 5)
    .map((t) => card(t, Math.max(0, today - dayOf(touched(t)))))

  // The grid starts on a Monday, so each column is a week.
  const weekday = (new Date(today * DAY_MS).getUTCDay() + 6) % 7
  const heatFrom = today - weekday - (HEAT_WEEKS - 1) * 7
  const perDay = new Map<number, number>()
  for (const c of finished) perDay.set(c.doneDay, (perDay.get(c.doneDay) ?? 0) + 1)
  const heat: BoardStats['heat'] = []
  for (let day = heatFrom; day <= today; day++) heat.push({ day, count: perDay.get(day) ?? 0 })

  // Overdue: a whole day once it's over, a time today once it has passed.
  const late = (due: string) => toDay(due) < today || (hasTime(due) && toDay(due) === today && Date.parse(due) < Date.now())
  const count = (list: { made?: number; doneDay?: number }[], key: 'made' | 'doneDay', a: number, b: number) =>
    list.filter((c) => within(c[key]!, a, b)).length
  return {
    days,
    open: open.length,
    inProgress: open.filter((t) => idx.category.get(t.id) === 'doing').length,
    overdue: open.filter((t) => t.due && late(t.due)).length,
    dueSoon: open.filter((t) => t.due && !late(t.due) && toDay(t.due) - today < 7).length,
    created: count(cards, 'made', from, today),
    createdBefore: count(cards, 'made', before, from - 1),
    done: took.length,
    doneBefore: count(finished, 'doneDay', before, from - 1),
    timeToDone: median(took),
    timeToDoneBefore: median(tookIn(before, from - 1)),
    quickest: took[0] ?? null,
    slowest: took.at(-1) ?? null,
    buckets,
    flow,
    lists: idx.columns
      .filter((c) => c.category !== 'done')
      .map((column) => ({ column, count: open.filter((t) => idx.status.get(t.id) === column.id).length })),
    oldest,
    untouched,
    heat,
  }
}
