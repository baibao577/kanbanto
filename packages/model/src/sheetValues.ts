import { PRIORITIES, type Priority } from './types'

/**
 * Reading what people type in spreadsheet cells: dates in the forms they have (day first or month first, month
 * names, Thai months and Buddhist-era years), numbers with thousands separators and currency signs, yes and no,
 * priorities. Each returns null for what it can't read: nothing is guessed past what the text says.
 */

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'
/** Thai digits as the usual ones, and the odd spaces spreadsheets put in (no-break, thin) as plain spaces. */
const plain = (s: string) =>
  s
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/[\u00a0\u2009\u202f]/g, ' ')
    .trim()

// ── Dates ───────────────────────────────────────────────

/** Whether a date written with numbers alone has the day first (15/10/2026) or the month (10/15/2026). */
export type DateOrder = 'dmy' | 'mdy'

const MONTHS: Record<string, number> = {}
;[
  ['jan', 'january', 'ม.ค.', 'มค', 'มกราคม'],
  ['feb', 'february', 'ก.พ.', 'กพ', 'กุมภาพันธ์'],
  ['mar', 'march', 'มี.ค.', 'มีค', 'มีนาคม'],
  ['apr', 'april', 'เม.ย.', 'เมย', 'เมษายน'],
  ['may', 'พ.ค.', 'พค', 'พฤษภาคม'],
  ['jun', 'june', 'มิ.ย.', 'มิย', 'มิถุนายน'],
  ['jul', 'july', 'ก.ค.', 'กค', 'กรกฎาคม'],
  ['aug', 'august', 'ส.ค.', 'สค', 'สิงหาคม'],
  ['sep', 'sept', 'september', 'ก.ย.', 'กย', 'กันยายน'],
  ['oct', 'october', 'ต.ค.', 'ตค', 'ตุลาคม'],
  ['nov', 'november', 'พ.ย.', 'พย', 'พฤศจิกายน'],
  ['dec', 'december', 'ธ.ค.', 'ธค', 'ธันวาคม'],
].forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)))
const isThai = (s: string) => /[\u0e00-\u0e7f]/.test(s)
/** A month by its name, English or Thai, whole or short, with or without the point after it. */
const monthOf = (word: string): number | undefined => MONTHS[word.toLowerCase()] ?? MONTHS[word.toLowerCase().replace(/[.,]+$/, '')]

export interface ReadDate {
  /** "2026-10-15". */
  day: string
  /** "14:30", when the cell had a time of day. */
  time?: string
}

/** A year as written: Buddhist era (2569) is 543 ahead; two digits are this century (or the Buddhist one, in Thai). */
function yearOf(text: string, thai: boolean): number | null {
  const y = Number(text)
  if (text.length === 2) return thai && y >= 43 ? 2500 + y - 543 : 2000 + y
  if (text.length !== 4) return null
  return y >= 2400 ? y - 543 : y
}

function dayOf(y: number | null, m: number, d: number): string | null {
  if (y === null || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const u = new Date(Date.UTC(y, m - 1, d))
  if (u.getUTCMonth() !== m - 1 || u.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** A time of day at the end of the text ("14:30", "2:30 PM", "14.30 น."), and the text before it. */
function splitTime(text: string): { rest: string; time?: string } | null {
  const m = /^(.*?)[\sT,]+(\d{1,2})[:.](\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm|a\.m\.|p\.m\.|น\.?)?(?:\s*(?:z|utc|[+-]\d{2}:?\d{2}))?$/i.exec(text)
  if (!m) return { rest: text }
  let h = Number(m[2])
  const min = Number(m[3])
  const half = m[4]?.toLowerCase().replace(/\./g, '')
  if (half === 'pm' && h < 12) h += 12
  if (half === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return { rest: m[1].trim(), time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` }
}

/**
 * What a date written with numbers alone could be: `d` and `m` when only one reading is a real date, `either` when
 * both are (3/4/2026), null when it isn't that kind of date.
 */
function numeric(text: string): { a: number; b: number; y: number | null } | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(text)
  return m ? { a: Number(m[1]), b: Number(m[2]), y: yearOf(m[3], false) } : null
}

/**
 * Which way round a column of dates is written, from all its values: `dmy` or `mdy` when some value only works one
 * way (31/10/2026) and none the other, `mixed` when values disagree, `either` when nothing decides (or no value is
 * a date written with numbers alone).
 */
export function dateOrderOf(values: string[]): DateOrder | 'either' | 'mixed' {
  let dmy = false
  let mdy = false
  for (const v of values) {
    const n = numeric(splitTime(plain(v))?.rest ?? '')
    if (!n) continue
    const asDmy = dayOf(n.y, n.b, n.a)
    const asMdy = dayOf(n.y, n.a, n.b)
    if (asDmy && !asMdy) dmy = true
    if (asMdy && !asDmy) mdy = true
  }
  return dmy && mdy ? 'mixed' : dmy ? 'dmy' : mdy ? 'mdy' : 'either'
}

/** Whether the text is a date written with numbers alone that reads both ways (3/4/2026). */
export function isAmbiguousDate(text: string): boolean {
  const n = numeric(splitTime(plain(text))?.rest ?? '')
  return !!n && n.a !== n.b && !!dayOf(n.y, n.b, n.a) && !!dayOf(n.y, n.a, n.b)
}

/**
 * A date as people write it. `order`: how to read one written with numbers alone when it could be either; without
 * it, such a date reads the only way it can, and one that could be either isn't read. `thisYear`: for "15 Oct".
 */
export function readDate(input: string, order?: DateOrder, thisYear = new Date().getUTCFullYear()): ReadDate | null {
  const split = splitTime(plain(input))
  if (!split || !split.rest) return null
  const text = split.rest
  const out = (day: string | null): ReadDate | null => (day ? { day, ...(split.time && { time: split.time }) } : null)

  // 2026-10-15, 2026/10/15, 2569-10-15
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
  if (iso) return out(dayOf(yearOf(iso[1], false), Number(iso[2]), Number(iso[3])))

  const n = numeric(text)
  if (n) {
    const asDmy = dayOf(n.y, n.b, n.a)
    const asMdy = dayOf(n.y, n.a, n.b)
    if (asDmy && asMdy && asDmy !== asMdy) return order ? out(order === 'dmy' ? asDmy : asMdy) : null
    return out(asDmy ?? asMdy)
  }

  // 15 Oct 2026, 15-Oct-26, 15 ตุลาคม 2569, 15 ต.ค. 68, and without a year
  const dayFirst = /^(\d{1,2})[\s-]*([^\d\s-][^\d\s]*?)[\s,-]*(\d{2}|\d{4})?$/.exec(text)
  if (dayFirst) {
    const month = monthOf(dayFirst[2])
    if (month) return out(dayOf(dayFirst[3] ? yearOf(dayFirst[3], isThai(dayFirst[2])) : thisYear, month, Number(dayFirst[1])))
  }
  // Oct 15, 2026 · October 15 2026 · Oct 15
  const monthFirst = /^([^\d\s]+?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(\d{4}))?$/i.exec(text)
  if (monthFirst) {
    const month = monthOf(monthFirst[1])
    if (month) return out(dayOf(monthFirst[3] ? yearOf(monthFirst[3], false) : thisYear, month, Number(monthFirst[2])))
  }
  return null
}

// ── Numbers ─────────────────────────────────────────────

/**
 * A number as people write it: "1,200.50", "1.200,50", "1 200", "฿1,200", "$40", "12%", "(500)" for minus 500. A
 * comma or point followed by exactly three digits is read as a thousands separator, unless it is the only one and
 * the number starts with 0 ("0,125").
 */
export function readNumber(input: string): number | null {
  let s = plain(input)
  if (!s) return null
  let sign = 1
  const bracketed = /^\((.*)\)$/.exec(s)
  if (bracketed) {
    sign = -1
    s = bracketed[1]
  }
  // Currency signs and units around it, and the spaces used to group digits.
  s = s.replace(/^[^\d+.,-]+/, '').replace(/[^\d.,]+$/, '')
  s = s.replace(/(\d)[ ' ](?=\d)/g, '$1')
  if (s.startsWith('-')) {
    sign = -sign
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null
  const lastComma = s.lastIndexOf(',')
  const lastPoint = s.lastIndexOf('.')
  let decimal = ''
  if (lastComma !== -1 && lastPoint !== -1) decimal = lastComma > lastPoint ? ',' : '.'
  else {
    const mark = lastComma !== -1 ? ',' : lastPoint !== -1 ? '.' : ''
    if (mark) {
      const parts = s.split(mark)
      const grouped = parts.length > 1 && parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3 && parts[0] !== '0' && parts[0] !== ''
      // "1,200" and "1.200.000" are grouped; "1.5", "0,125" and "12,5" have a decimal mark. One point followed by
      // three digits ("1.200") is a decimal where the point is the usual mark, so only a comma groups there.
      if (!(grouped && (mark === ',' || parts.length > 2))) {
        if (parts.length > 2) return null
        decimal = mark
      }
    }
  }
  const at = decimal ? s.lastIndexOf(decimal) : -1
  const [whole, frac] = at === -1 ? [s, ''] : [s.slice(0, at), s.slice(at + 1)]
  if (decimal && whole.includes(decimal)) return null
  const digits = whole.replace(/[.,]/g, '')
  if (!/^\d*$/.test(digits) || !/^\d*$/.test(frac) || (!digits && !frac)) return null
  const n = sign * Number(`${digits || '0'}${frac ? `.${frac}` : ''}`)
  return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : null
}

// ── Yes and no, priorities ──────────────────────────────

const YES = new Set(['yes', 'y', 'true', 't', '1', 'x', '✓', '✔', '☑', 'checked', 'done', 'on', 'ใช่', 'จริง', 'เสร็จ', 'เสร็จแล้ว'])
const NO = new Set(['no', 'n', 'false', 'f', '0', '', '-', '☐', 'unchecked', 'off', 'ไม่', 'ไม่ใช่', 'เท็จ'])

/** A ticked box or not, as people write it; null when it's neither. */
export function readYes(input: string): boolean | null {
  const s = plain(input).toLowerCase()
  return YES.has(s) ? true : NO.has(s) ? false : null
}

const PRIORITY_WORDS: Record<string, Priority> = {
  critical: 'urgent',
  highest: 'urgent',
  p0: 'urgent',
  p1: 'high',
  p2: 'medium',
  p3: 'low',
  normal: 'medium',
  med: 'medium',
  lowest: 'low',
  ด่วนมาก: 'urgent',
  เร่งด่วน: 'urgent',
  ด่วน: 'urgent',
  สูง: 'high',
  กลาง: 'medium',
  ปานกลาง: 'medium',
  ต่ำ: 'low',
}

/** A priority as people write it; null when it isn't one. */
export function readPriority(input: string): Priority | null {
  const s = plain(input).toLowerCase()
  return (PRIORITIES as readonly string[]).includes(s) ? (s as Priority) : (PRIORITY_WORDS[s] ?? null)
}
