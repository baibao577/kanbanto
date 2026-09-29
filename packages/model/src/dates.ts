import type { Task } from './types'

/**
 * A task's start or due is either a whole day, "2026-10-15" (the same day for everyone), or, with a time, an exact
 * moment in UTC, "2026-10-15T07:30:00Z", which each person sees in their own time zone (24-hour clock).
 *
 * Days are handled as whole day numbers (days since 1970-01-01), so there are no time-zone or DST surprises; a moment
 * counts as the day it falls on where you are.
 */
const DAY_MS = 86_400_000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const pad = (n: number) => String(n).padStart(2, '0')
const localDayString = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const canonical = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z'

/** Has a time (it's a moment, not a whole day). */
export const hasTime = (v: string) => v.length > 10

/**
 * The stored form of a task date, or null if it isn't one: a real calendar day as-is, and a date-time with its time
 * zone (Z or +07:00) as a UTC moment to the minute, "2026-10-15T07:30:00Z".
 */
export function normalizeTaskDate(v: string): string | null {
  if (DAY.test(v)) {
    const [y, m, d] = v.split('-').map(Number)
    const u = new Date(Date.UTC(y, m - 1, d))
    return u.getUTCFullYear() === y && u.getUTCMonth() === m - 1 && u.getUTCDate() === d ? v : null
  }
  // A time zone is required: without one, the same text would mean a different moment on every computer.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : canonical(Math.floor(ms / 60_000) * 60_000)
}

/** The calendar day it falls on, where you are ("2026-10-15"). A whole day is itself. */
export const localDayOf = (v: string) => (hasTime(v) ? localDayString(new Date(v)) : v)

/** Its time where you are, "14:30" (24-hour), or null for a whole day. */
export function localTimeOf(v: string): string | null {
  if (!hasTime(v)) return null
  const d = new Date(v)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The moment `time` ("14:30") on `day` ("2026-10-15"), where you are. */
export function momentAt(day: string, time: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const [h, min] = time.split(':').map(Number)
  return canonical(new Date(y, m - 1, d, h, min).getTime())
}

/** A time as people type it: "14:30", "1430", "9", "9.15", "09h05" → "14:30"; null if it isn't a time of day. */
export function parseTime(input: string): string | null {
  const s = input.trim().replace(/\s+/g, '')
  const m = s.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?$/)
  if (!m) return null
  const h = Number(m[1])
  const min = m[2] === undefined ? 0 : Number(m[2])
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null
}

/** Moves a task date by whole days, keeping its time. */
export function shiftDays(v: string, days: number): string {
  if (!hasTime(v)) return fromDay(toDay(v) + days)
  const d = new Date(v)
  d.setDate(d.getDate() + days) // local days, so the clock time stays the same across a DST change
  return canonical(d.getTime())
}

/** It's past: a whole day once it's over, a moment once it has passed. */
export const isPast = (v: string, now = Date.now()) => (hasTime(v) ? Date.parse(v) < now : toDay(v) < todayDay())

/** For sorting: when it is (a whole day sorts at the start of that day where you are). */
export function sortTime(v: string): number {
  if (hasTime(v)) return Date.parse(v)
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** The day number of a task date (a moment: the day it falls on where you are). */
export const toDay = (iso: string): number => {
  const [y, m, d] = localDayOf(iso).split('-').map(Number)
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
 * A task's bar: `start`..`due`, inclusive, in whole days. Only one of them set → a one-day bar.
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
