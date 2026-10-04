import { hasTime } from './dates'
import type { Reminder, Task } from './types'

/** When a whole-day due date is "due", for reminders counted back from it: 9:00 on that day, the setter's time. */
export const DUE_DAY_HOUR = 9

/** The moment a reminder fires (null: it can't yet, e.g. "before it's due" on a task with no due date). */
export function fireTime(r: Reminder, task: Pick<Task, 'due'>): Date | null {
  // (A stored time that isn't one, from an old file, never fires: null, not an Invalid Date.)
  const real = (d: Date) => (Number.isNaN(d.getTime()) ? null : d)
  if (r.at) return real(new Date(r.at))
  if (r.beforeDue === undefined || !task.due) return null
  const due = hasTime(task.due) ? new Date(task.due) : zoned(task.due, DUE_DAY_HOUR, r.tz)
  return real(new Date(due.getTime() - r.beforeDue * 60_000))
}

/** A task's reminders that still have a moment, soonest first. */
export function upcoming(task: Pick<Task, 'due' | 'reminders'>, after = new Date()): { reminder: Reminder; at: Date }[] {
  return (task.reminders ?? [])
    .map((reminder) => ({ reminder, at: fireTime(reminder, task) }))
    .filter((x): x is { reminder: Reminder; at: Date } => !!x.at && x.at > after)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** `hour`:00 on `day` (YYYY-MM-DD) in a time zone (UTC when unknown), as a moment. */
export function zoned(day: string, hour: number, tz?: string): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  if (!tz) return new Date(guess)
  try {
    // The zone's offset at that moment: format the guess there, and compare.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    )
    const there = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute)
    return new Date(guess - (there - guess))
  } catch {
    return new Date(guess)
  }
}
