import * as chrono from 'chrono-node'
import { zoned } from './reminders'

/** A time from plain words ("tmr 10:00", "wed1pm", "next monday 1pm", "in 2 hours"), and the words it came from. */
export interface When {
  date: Date
  /** The day it falls on (YYYY-MM-DD), where the words were read: the reader's clock, or the time zone given. */
  day: string
  /** The words that were read as the time (to highlight, or take out of a title). */
  text: string
  index: number
  /** A time of day was given (else it's 9:00 on that day). */
  timed: boolean
}

/** With no time of day, "friday" means 9:00 that day. */
const DEFAULT_HOUR = 9
const two = (n: number) => String(n).padStart(2, '0')

/** How far a time zone's clock is ahead of UTC at a moment, in minutes. */
function offsetOf(zone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const there = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute)
  return Math.round((there - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000)
}

/**
 * Reads a time from plain words, in the future. Shortcuts people type work too: "tmr"/"tmrw"/"tml" for tomorrow,
 * and no space between a word and a time ("tmr10:00", "wed1pm"). English only.
 *
 * The words are read on the clock of whoever runs this (a browser: its person's). `zone` reads them on that time
 * zone's clock instead: for a server, where "tomorrow 3pm" means the afternoon where the person is.
 */
export function parseWhen(text: string, ref = new Date(), zone?: string): When | null {
  const { spaced, from } = tidy(text)
  const [r] = zone
    ? chrono.parse(spaced, { instant: ref, timezone: offsetOf(zone, ref) }, { forwardDate: true })
    : chrono.parse(spaced, ref, { forwardDate: true })
  if (!r) return null
  const timed = r.start.isCertain('hour')
  let date = r.start.date()
  let day: string
  if (zone && r.start.isCertain('timezoneOffset')) {
    // (The words said their own zone, "3pm UTC": the moment is that; the day is the one it falls on in `zone`.)
    const there = new Date(date.getTime() + offsetOf(zone, date) * 60_000)
    day = `${there.getUTCFullYear()}-${two(there.getUTCMonth() + 1)}-${two(there.getUTCDate())}`
  } else if (zone) {
    // What chrono read is a day and a time on that zone's clock: the moment is worked out from them there, so a
    // clock change between now and then (summer time) can't move it by an hour.
    day = `${r.start.get('year')}-${two(r.start.get('month')!)}-${two(r.start.get('day')!)}`
    date = zoned(day, timed ? r.start.get('hour')! : DEFAULT_HOUR, zone, timed ? (r.start.get('minute') ?? 0) : 0)
  } else {
    if (!timed) date.setHours(DEFAULT_HOUR, 0, 0, 0)
    day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  }
  // Back to the words as typed.
  const index = from[r.index]
  const end = from[r.index + r.text.length - 1] + 1
  return { date, day, text: text.slice(index, end), index, timed }
}

/** A due moment (or a reminder's): UTC, to the minute. */
export const moment = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** What a card's due date is for a time that was read: the moment when a time of day was said, else the whole day. */
export const dueOf = (when: When) => (when.timed ? moment(when.date) : when.day)

/** The title with the time's words (and a leftover "on"/"at"/"by"/"due") taken out. */
export function stripWords(title: string, when: When): string {
  const before = title.slice(0, when.index).replace(/\s+(on|at|by|due)\s*$/i, '')
  return `${before} ${title.slice(when.index + when.text.length)}`.replace(/\s{2,}/g, ' ').replace(/^[\s,–-]+|[\s,–-]+$/g, '')
}

/**
 * A time typed into a title ("call Sam tomorrow 3pm"): the title without those words, and the due date they mean.
 * Null when there is no time in it, or nothing but the time.
 */
export function titleDate(title: string, ref = new Date(), zone?: string): { title: string; due: string; when: When } | null {
  const when = title.trim() ? parseWhen(title, ref, zone) : null
  if (!when) return null
  const left = stripWords(title, when)
  return left ? { title: left, due: dueOf(when), when } : null
}

/**
 * The text as chrono reads it best: "tmr" → "tomorrow", and a space between a word and a number ("wed1pm" → "wed
 * 1pm"). `from[i]` is where character i came from in the original, to find the words again.
 */
function tidy(text: string) {
  let spaced = ''
  const from: number[] = []
  const tomorrow = /(?:tmrw?|tml)\b/iy
  for (let i = 0; i < text.length;) {
    tomorrow.lastIndex = i
    const m = !/[a-z]/i.test(text[i - 1] ?? '') && tomorrow.exec(text)
    if (m) {
      for (let k = 0; k < 8; k++) from.push(k < 7 ? i : i + m[0].length - 1)
      spaced += 'tomorrow'
      i += m[0].length
      continue
    }
    spaced += text[i]
    from.push(i)
    if (/[a-z]/i.test(text[i]) && /\d/.test(text[i + 1] ?? '')) {
      spaced += ' '
      from.push(i)
    }
    i++
  }
  return { spaced, from }
}
