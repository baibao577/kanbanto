import { hasTime, toDay, todayDay } from '@kanbanto/model/dates'

/**
 * How far off a due date is, for the card window's Dates cell: "8 days left", "due tomorrow", "due today",
 * "3 days late". Counted by the day where the person is. `late`: it has passed (to the minute, when it has a time;
 * a date with no time is late from the day after).
 */
export function dueWords(due: string, today = todayDay(), now = Date.now()): { text: string; late: boolean } {
  const days = toDay(due) - today
  const late = hasTime(due) ? Date.parse(due) < now : days < 0
  if (days < 0) return { text: days === -1 ? '1 day late' : `${-days} days late`, late: true }
  if (days === 0) return { text: late ? 'was due today' : 'due today', late }
  if (days === 1) return { text: 'due tomorrow', late: false }
  return { text: `${days} days left`, late: false }
}
