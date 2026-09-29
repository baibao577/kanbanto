import type { Task } from './types'

// Dates are handled as whole UTC day numbers (days since 1970-01-01), so there are no time-zone or DST surprises.
const DAY_MS = 86_400_000

export const toDay = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY_MS
}

export const fromDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10)

export const todayDay = (): number => {
  const d = new Date()
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS
}

/** Calendar parts of a day number. */
export const dayParts = (day: number) => {
  const d = new Date(day * DAY_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(), weekday: d.getUTCDay() }
}

/**
 * A task's bar: `start`..`due`, inclusive. Only one of them set → a one-day bar.
 * Returns null for unscheduled tasks.
 */
export function taskSpan(t: Task): { start: number; end: number } | null {
  const s = t.start ?? t.due
  const e = t.due ?? t.start
  if (!s || !e) return null
  const a = toDay(s)
  const b = toDay(e)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}
