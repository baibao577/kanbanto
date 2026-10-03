/**
 * Time people log on cards: "3h 20m on API integration, Thursday". Entries are typed by people (never guessed), so
 * reading what they type must be predictable: a plain number is always hours.
 */

/** The most one entry can hold: a whole day. */
export const MAX_MINUTES = 24 * 60
/** Above this a plain number is refused: "20" is more likely 20 minutes than 20 hours. */
export const MAX_BARE_HOURS = 12
/** One entry longer than this, or a day logged past LONG_DAY, gets a word of warning (not a refusal). */
export const LONG_ENTRY = 8 * 60
export const LONG_DAY = 10 * 60
/** The one-click amounts in the log box. */
export const QUICK = [15, 30, 60, 120, 240] as const

export type ParsedLog = { ok: true; minutes: number; note: string; warning: string | null } | { ok: false; error: string }

const NUM = String.raw`\d+(?:[.,]\d+)?`
// "3h", "3h 20m", "3h20", "1.5h", "90m", "45 min", "1:30", or a plain number (hours).
const DURATION = String.raw`(?:${NUM}\s*h(?:ours?|rs?)?(?:\s*\d{1,2}\s*m(?:ins?|inutes?)?|\s*\d{1,2}(?![\d.,:]))?|\d+\s*m(?:ins?|inutes?)?|\d{1,2}:\d{2}|${NUM})`
// Between a time and its note: spaces, or a dash, colon, comma or dot with spaces around.
const SEP = String.raw`(?:\s*[-–—:,·]\s+|\s+[-–—:,·]?\s*)`
const AT_START = new RegExp(String.raw`^(${DURATION})(?:${SEP}(.*))?$`, 'i')
const AT_END = new RegExp(String.raw`^(.*?)${SEP}(${DURATION})$`, 'i')
const ONLY = new RegExp(String.raw`^(${DURATION})$`, 'i')

const toNumber = (s: string) => Number(s.replace(',', '.'))

/** Minutes in a duration as matched by DURATION, or an error for a plain number that's too big to be hours. */
function durationMinutes(raw: string): number | { error: string } {
  const s = raw.trim().toLowerCase()
  const clock = s.match(/^(\d{1,2}):(\d{2})$/)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  const hours = s.match(new RegExp(String.raw`^(${NUM})\s*h[a-z]*\s*(?:(\d{1,2})\s*m?[a-z]*)?$`))
  if (hours) return Math.round(toNumber(hours[1]) * 60) + Number(hours[2] ?? 0)
  const mins = s.match(/^(\d+)\s*m[a-z]*$/)
  if (mins) return Number(mins[1])
  const bare = toNumber(s)
  if (bare > MAX_BARE_HOURS) return { error: `${s} hours? Type ${s}m for minutes.` }
  return Math.round(bare * 60)
}

/**
 * What someone typed in the log box: a time and, if they like, a note, either way round ("3h 20m review",
 * "API integration – 3h 20m", "1:30", "90m", "1.5", "1,5"). A plain number is hours (up to 12).
 */
export function parseLog(input: string): ParsedLog {
  const text = input.trim().replace(/\s+/g, ' ')
  if (!text) return { ok: false, error: 'Type a time, like 1h 30m or 45m.' }
  const start = text.match(AT_START)
  const end = start ? null : text.match(AT_END)
  const [dur, note] = start ? [start[1], start[2] ?? ''] : end ? [end[2], end[1]] : [null, '']
  if (!dur) return { ok: false, error: 'Add a time, like 1h 30m or 45m.' }
  const minutes = durationMinutes(dur)
  if (typeof minutes !== 'number') return { ok: false, error: minutes.error }
  if (minutes < 1) return { ok: false, error: 'That’s no time at all.' }
  if (minutes > MAX_MINUTES) return { ok: false, error: 'One entry can be up to 24h.' }
  return {
    ok: true,
    minutes,
    note: note.trim().slice(0, 200),
    warning: minutes > LONG_ENTRY ? `That’s ${formatDuration(minutes)} in one go. Sure?` : null,
  }
}

/** Just a time, as typed in a cell of My week ("2", "1:30", "45m"); null if it isn't one. */
export function parseDuration(input: string): number | { error: string } | null {
  const text = input.trim().replace(/\s+/g, ' ')
  if (!ONLY.test(text)) return null
  const m = durationMinutes(text)
  if (typeof m !== 'number') return m
  if (m > MAX_MINUTES) return { error: 'One entry can be up to 24h.' }
  return m < 1 ? null : m
}

/** "3h 20m", "45m", "8h". */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** Hours as a short number for totals: "3.5", "12", "0.3". */
export const formatHours = (minutes: number) => String(Math.round((minutes / 60) * 10) / 10)

/** Logged time as man-days: one man-day is one of the person's working days (their hours a day). */
export const toManDays = (minutes: number, hoursPerDay = 8) => minutes / 60 / hoursPerDay
