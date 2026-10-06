import { localTimeOf, mondayOf, monthEndOf, monthStartOf, taskSpan } from './dates'
import type { TaskIndex } from './indexer'

/**
 * Cards laid out by day, for the Timeline's calendar: which day each card is on, the weeks of days to draw, and
 * where a card that lasts several days runs across them. Days are day numbers, as in dates.ts (`toDay`).
 */

/** A card as the calendar places it: the days it covers (one, when `start` is `end`), and its time on that day. */
export interface DayCard {
  id: string
  start: number
  end: number
  /** "14:30": a card on one day that has a time of day. A card that lasts days has none. */
  time?: string
}

/**
 * The ones of `ids` that have a date, where each sits: on its due day (or its start, without one), or from its
 * start to its due date. Cards without a date aren't on a calendar.
 */
export function datedCards(idx: TaskIndex, ids: Iterable<string>): DayCard[] {
  const out: DayCard[] = []
  for (const id of ids) {
    const t = idx.tasks[id]
    const span = t && taskSpan(t)
    if (!span) continue
    const time = span.start === span.end ? localTimeOf(t.due ?? t.start!) : null
    out.push({ id, ...span, ...(time && { time }) })
  }
  return out
}

/** One week of the grid, Monday first. */
export interface WeekRow {
  /** Its Monday. */
  first: number
  /**
   * Cards that last several days, as bars across the days they cover in this week (`from` and `to`: 0 for Monday
   * to 6), each in a lane so two never overlap. `before`, `after`: it goes on into the week before, or the next.
   */
  bars: { id: string; from: number; to: number; lane: number; before: boolean; after: boolean }[]
  lanes: number
  /** Each day's own cards (the ones on that day alone): the ones without a time first, then by time. */
  days: string[][]
}

const byTime = (a: DayCard, b: DayCard) => (a.time ?? '').localeCompare(b.time ?? '')

/** `weeks` weeks of days from the Monday `first`, with the cards on them. Cards keep the order given, within a time. */
export function weekRows(cards: DayCard[], first: number, weeks: number): WeekRow[] {
  const single = cards.filter((c) => c.start === c.end)
  const long = cards.filter((c) => c.start !== c.end).sort((a, b) => a.start - b.start || b.end - a.end)
  const byDay = new Map<number, DayCard[]>()
  for (const c of single) {
    const of = byDay.get(c.start)
    if (of) of.push(c)
    else byDay.set(c.start, [c])
  }
  const out: WeekRow[] = []
  for (let w = 0; w < weeks; w++) {
    const from = first + w * 7
    const to = from + 6
    // The first lane with room: whose last bar ends before this one starts.
    const ends: number[] = []
    const bars = long
      .filter((c) => c.start <= to && c.end >= from)
      .map((c) => {
        const a = Math.max(c.start, from) - from
        const b = Math.min(c.end, to) - from
        let lane = ends.findIndex((end) => end < a)
        if (lane === -1) lane = ends.push(b) - 1
        else ends[lane] = b
        return { id: c.id, from: a, to: b, lane, before: c.start < from, after: c.end > to }
      })
    const days = Array.from({ length: 7 }, (_, i) => [...(byDay.get(from + i) ?? [])].sort(byTime).map((c) => c.id))
    out.push({ first: from, bars, lanes: ends.length, days })
  }
  return out
}

/** One day: the cards that are on it alone, in time order, and the longer ones that cover it. */
export function dayCards(cards: DayCard[], day: number): { long: string[]; cards: DayCard[] } {
  return {
    long: cards.filter((c) => c.start !== c.end && c.start <= day && c.end >= day).map((c) => c.id),
    cards: cards.filter((c) => c.start === c.end && c.start === day).sort(byTime),
  }
}

/** The weeks a month's grid shows: from the Monday on or before its first day, through the week of its last. */
export function monthWeeks(day: number): { first: number; weeks: number } {
  const first = mondayOf(monthStartOf(day))
  return { first, weeks: Math.floor((monthEndOf(day) - first) / 7) + 1 }
}
