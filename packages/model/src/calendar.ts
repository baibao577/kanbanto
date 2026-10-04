import { fromDay, hasTime, toDay } from './dates'
import { indexFor } from './indexer'
import { fireTime } from './reminders'
import type { BoardData } from './types'

/**
 * A person's calendar: what a board puts in it. The same rule feeds the calendar link (an .ics file, see ics.ts) and
 * the Google Calendar connection, so both always show the same things.
 *
 * - A card's due date is theirs when the card is assigned to them, or it's assigned to nobody and they are the only
 *   person on the board. A whole day is an all-day event; a moment is DUE_MINUTES long, starting then.
 * - A reminder is theirs when it would reach them (the assignee, or whoever set it when nobody is assigned: the rule
 *   the server sends them by). It's an alert on the due event when a calendar can say it that way (the due date has
 *   a time, and the reminder comes up to four weeks before it); otherwise it's a short event of its own.
 * - Done cards keep their due date, ticked, without alerts or reminders. Archived cards aren't in `data.tasks`.
 */
export interface CalendarItem {
  /** Which part of the task: 'due', or 'r:<reminder id>' for a reminder that is an event of its own. */
  key: string
  taskId: string
  /** As the calendar shows it: "Title", "✓ Title" once done, "⏰ Title" for a reminder. */
  title: string
  when: CalendarWhen
  /** Minutes before it starts that the calendar should tell them. */
  alerts: number[]
}

/** A whole day, or from one moment to another (UTC, "2026-10-15T07:30:00Z"). */
export type CalendarWhen = { day: string } | { start: string; end: string }

export const DUE_MINUTES = 30
export const REMINDER_MINUTES = 15
/** What Google Calendar accepts on one event: alerts up to four weeks before, five of them. */
export const MAX_ALERT_MINUTES = 40_320
export const MAX_ALERTS = 5

const MINUTE = 60_000
const moment = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z'
const span = (startMs: number, minutes: number): CalendarWhen => ({ start: moment(startMs), end: moment(startMs + minutes * MINUTE) })

/** The day after a whole day ("2026-10-16" for "2026-10-15"): calendars end an all-day event there. */
export const dayAfter = (day: string) => fromDay(toDay(day) + 1)

/**
 * `maxAlerts`: how many reminders may ride on the due event as alerts. 0 makes every reminder its own event (for
 * calendar links: Google ignores alerts in a subscribed calendar, and Apple removes them unless told not to).
 */
export function calendarItems(data: BoardData, userId: string, { maxAlerts = MAX_ALERTS } = {}): CalendarItem[] {
  const idx = indexFor(data)
  const alone = data.members.length === 1 && data.members[0].id === userId
  const out: CalendarItem[] = []
  for (const t of Object.values(data.tasks)) {
    const done = idx.category.get(t.id) === 'done'
    const mine = t.assigneeId ? t.assigneeId === userId : alone
    const due: CalendarItem | null =
      mine && t.due
        ? {
            key: 'due',
            taskId: t.id,
            title: done ? `✓ ${t.title}` : t.title,
            when: hasTime(t.due) ? span(Date.parse(t.due), DUE_MINUTES) : { day: t.due },
            alerts: [],
          }
        : null
    if (due) out.push(due)
    if (done) continue
    for (const r of t.reminders ?? []) {
      if ((t.assigneeId ?? r.by) !== userId) continue
      const at = fireTime(r, t)
      if (!at) continue
      if (due && t.due && hasTime(t.due)) {
        const before = Math.round((Date.parse(t.due) - at.getTime()) / MINUTE)
        if (due.alerts.includes(before)) continue
        if (before >= 0 && before <= MAX_ALERT_MINUTES && due.alerts.length < maxAlerts) {
          due.alerts.push(before)
          continue
        }
      }
      out.push({ key: `r:${r.id}`, taskId: t.id, title: `⏰ ${t.title}`, when: span(at.getTime(), REMINDER_MINUTES), alerts: [0] })
    }
  }
  return out
}
