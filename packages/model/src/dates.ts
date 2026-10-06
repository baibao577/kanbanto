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

/** The weekday of a day number: 0 = Sunday … 6 = Saturday (day 0, 1970-01-01, was a Thursday). */
export const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7

export const isWeekend = (day: number) => weekdayOf(day) === 0 || weekdayOf(day) === 6

/** The Monday of the week a day number is in (weeks run Monday to Sunday). */
export const mondayOf = (day: number) => day - ((weekdayOf(day) + 6) % 7)

/** The first day of the month a day number is in. */
export const monthStartOf = (day: number) => day - dayParts(day).date + 1

/** The last day of the month a day number is in. */
export const monthEndOf = (day: number) => monthStartOf(monthStartOf(day) + 31) - 1

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

// ── A day in someone's time zone ────────────────────────

/** A time zone this computer knows ("Asia/Bangkok"). */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const dayFormats = new Map<string, Intl.DateTimeFormat>()
/** "2026-10-01": the day a moment falls on in a time zone. */
export function dayIn(d: Date, zone: string): string {
  let format = dayFormats.get(zone)
  if (!format)
    dayFormats.set(zone, (format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })))
  return format.format(d)
}

/**
 * The day number of a task date for someone in `zone`: a whole day is itself, a moment is the day it falls on there.
 * (`toDay` does the same for where this code runs, which is right in a browser and wrong on a server.)
 */
export const dayNumberIn =
  (zone: string) =>
  (date: string): number => {
    const [y, m, d] = (hasTime(date) ? dayIn(new Date(date), zone) : date).split('-').map(Number)
    return Date.UTC(y, m - 1, d) / DAY_MS
  }

// ── Tests of a day, for filters ─────────────────────────

/**
 * Words for days counted from today: a day, a week (Monday to Sunday), a month, everything before or after today,
 * the "next" or "last" so many days (today included), and whether there is a date at all.
 */
export const DATE_WORDS = [
  'today',
  'tomorrow',
  'yesterday',
  'this-week',
  'next-week',
  'last-week',
  'this-month',
  'next-month',
  'last-month',
  'past',
  'future',
  'next',
  'last',
  'any',
  'none',
] as const
export type DateWord = (typeof DATE_WORDS)[number]

/**
 * One test of a day, for a filter: a word (`on`; "next" and "last" go with `days`), or the whole days it has to lie
 * between, both included (`from` alone: on or after it; `to` alone: on or before it). One kind or the other.
 */
export interface DateTest {
  on?: DateWord
  days?: number
  from?: string
  to?: string
}

const isWholeDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && normalizeTaskDate(v) === v
const isDateWord = (v: unknown): v is DateWord => (DATE_WORDS as readonly unknown[]).includes(v)
/** The most days "next" and "last" count. */
export const MAX_DATE_DAYS = 3650

/** The days a word covers, first and last (either may have no end). Not for "any" and "none". */
function wordSpan(on: DateWord, today: number, days = 0): [number, number] {
  switch (on) {
    case 'tomorrow':
      return [today + 1, today + 1]
    case 'yesterday':
      return [today - 1, today - 1]
    case 'this-week':
      return [mondayOf(today), mondayOf(today) + 6]
    case 'next-week':
      return [mondayOf(today) + 7, mondayOf(today) + 13]
    case 'last-week':
      return [mondayOf(today) - 7, mondayOf(today) - 1]
    case 'this-month':
      return [monthStartOf(today), monthEndOf(today)]
    case 'next-month':
      return [monthEndOf(today) + 1, monthEndOf(monthEndOf(today) + 1)]
    case 'last-month':
      return [monthStartOf(monthStartOf(today) - 1), monthStartOf(today) - 1]
    case 'past':
      return [-Infinity, today - 1]
    case 'future':
      return [today + 1, Infinity]
    case 'next':
      return [today, today + days]
    case 'last':
      return [today - days, today]
    default:
      return [today, today]
  }
}

/** Does a day pass the test? `day`: its day number, or undefined when there is no date. `today`: a day number too. */
export function dateMatches(day: number | undefined, t: DateTest, today: number): boolean {
  // (A test that asks nothing passes everything: one whose only part this version didn't know mustn't hide cards.)
  if (t.on === undefined && t.from === undefined && t.to === undefined) return true
  if (t.on === 'none') return day === undefined
  if (day === undefined) return false
  if (t.on === 'any') return true
  const [first, last] = t.on ? wordSpan(t.on, today, t.days) : [t.from ? toDay(t.from) : -Infinity, t.to ? toDay(t.to) : Infinity]
  return day >= first && day <= last
}

/**
 * A test kept to what means something: a word it knows ("next" and "last" only with a whole number of days), or
 * real days. Undefined when nothing is left. The same object comes back when nothing had to go.
 */
export function tidyDateTest(t: DateTest): DateTest | undefined {
  let out: DateTest | undefined
  if (isDateWord(t.on)) {
    const counted = t.on === 'next' || t.on === 'last'
    const days = Number.isInteger(t.days) && t.days! >= 1 && t.days! <= MAX_DATE_DAYS ? t.days : undefined
    if (!counted) out = { on: t.on }
    else if (days) out = { on: t.on, days }
  } else if (isWholeDay(t.from) || isWholeDay(t.to)) out = { ...(isWholeDay(t.from) && { from: t.from }), ...(isWholeDay(t.to) && { to: t.to }) }
  if (!out) return undefined
  const kept = out
  const had = (['on', 'days', 'from', 'to'] as const).filter((k) => t[k] !== undefined)
  return had.length === Object.keys(kept).length && had.every((k) => kept[k] === t[k]) ? t : kept
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A whole day in a few letters: "1 Oct", with its year when it isn't this one. */
export function shortDay(day: string, today = todayDay()): string {
  const { year, month, date } = dayParts(toDay(day))
  return `${date} ${MONTHS_SHORT[month]}${year === dayParts(today).year ? '' : ` ${year}`}`
}

const DATE_WORD_TEXT: Record<DateWord, string> = {
  today: 'today',
  tomorrow: 'tomorrow',
  yesterday: 'yesterday',
  'this-week': 'this week',
  'next-week': 'next week',
  'last-week': 'last week',
  'this-month': 'this month',
  'next-month': 'next month',
  'last-month': 'last month',
  past: 'in the past',
  future: 'in the future',
  next: 'in the next',
  last: 'in the last',
  any: 'has a date',
  none: 'no date',
}

/** A test in words, to follow a name: "today", "in the next 30 days", "from 1 Oct to 31 Oct", "on or before 31 Oct". */
export function dateTestText(t: DateTest, today = todayDay()): string {
  if (t.on === 'next' || t.on === 'last') return `${DATE_WORD_TEXT[t.on]} ${t.days === 1 ? 'day' : `${t.days} days`}`
  if (t.on) return DATE_WORD_TEXT[t.on]
  if (t.from && t.to) return t.from === t.to ? `on ${shortDay(t.from, today)}` : `from ${shortDay(t.from, today)} to ${shortDay(t.to, today)}`
  if (t.from) return `on or after ${shortDay(t.from, today)}`
  return t.to ? `on or before ${shortDay(t.to, today)}` : ''
}

/** A test as text for an address: a word, "next-30", "last-7", or days as "2026-10-01..2026-10-31" (either may be left out). */
export function dateTestToText(t: DateTest): string {
  if (t.on === 'next' || t.on === 'last') return `${t.on}-${t.days}`
  return t.on ?? (t.from || t.to ? `${t.from ?? ''}..${t.to ?? ''}` : '')
}

/** Reads `dateTestToText` back. Undefined when the text isn't a test. */
export function dateTestFromText(text: string): DateTest | undefined {
  const t = text.trim()
  const counted = t.match(/^(next|last)-(\d{1,4})$/)
  if (counted) return tidyDateTest({ on: counted[1] as DateWord, days: Number(counted[2]) })
  if (t.includes('..')) {
    const [from, to] = t.split('..')
    return (from === '' || isWholeDay(from)) && (to === '' || isWholeDay(to)) ? tidyDateTest({ ...(from && { from }), ...(to && { to }) }) : undefined
  }
  return isDateWord(t) && t !== 'next' && t !== 'last' ? { on: t } : undefined
}
