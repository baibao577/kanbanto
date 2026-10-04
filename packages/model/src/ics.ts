import { dayAfter, type CalendarWhen } from './calendar'

/**
 * A calendar as an .ics file (iCalendar, RFC 5545): what calendar apps read from a link they subscribe to. Lines end
 * with CRLF and are folded at 75 bytes; text has its commas, semicolons, backslashes and line breaks escaped.
 */
export interface IcsEvent {
  /** The same for the same event every time, and different from every other event's. */
  uid: string
  title: string
  description?: string
  url?: string
  when: CalendarWhen
  /** Minutes before it starts. */
  alerts: number[]
  /** When it last changed (an ISO date-time). */
  changedAt: string
}

/** How often apps are asked to look again. (Google decides for itself: a few times a day.) */
const REFRESH = 'PT1H'

const text = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[,;]/g, '\\$&')
    // Other control characters have no place in a calendar file.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

const stamp = (iso: string) => {
  const ms = Date.parse(iso)
  return new Date(Number.isNaN(ms) ? 0 : ms).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
}
const day = (d: string) => d.replace(/-/g, '')

const bytesOf = (codePoint: number) => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4)

/** One line, folded: at most 75 bytes each, later pieces starting with a space, never cutting a character in two. */
export function foldLine(line: string): string {
  const out: string[] = []
  let piece = ''
  let size = 0
  for (const ch of line) {
    const n = bytesOf(ch.codePointAt(0)!)
    if (size + n > 75) {
      out.push(piece)
      piece = ' '
      size = 1
    }
    piece += ch
    size += n
  }
  out.push(piece)
  return out.join('\r\n')
}

export function toIcs({ name, events }: { name: string; events: IcsEvent[] }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kanbanto//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
  ]
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${text(e.uid)}`, `DTSTAMP:${stamp(e.changedAt)}`)
    if ('day' in e.when) lines.push(`DTSTART;VALUE=DATE:${day(e.when.day)}`, `DTEND;VALUE=DATE:${day(dayAfter(e.when.day))}`)
    else lines.push(`DTSTART:${stamp(e.when.start)}`, `DTEND:${stamp(e.when.end)}`)
    lines.push(`SUMMARY:${text(e.title)}`)
    if (e.description) lines.push(`DESCRIPTION:${text(e.description)}`)
    if (e.url) lines.push(`URL:${e.url}`)
    // A deadline doesn't make you busy.
    lines.push('TRANSP:TRANSPARENT')
    for (const minutes of e.alerts)
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(e.title)}`, `TRIGGER:${minutes ? `-PT${minutes}M` : 'PT0M'}`, 'END:VALARM')
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
