import { format } from 'date-fns'
import { periodOf } from '@kanbanto/model/search'

/** When a line came, said as briefly as its heading allows: the time today and yesterday, the day this week, the date before. */
export function whenOf(at: Date, now: Date): string {
  const period = periodOf(at.getTime(), now)
  if (period === 'Today' || period === 'Yesterday') return format(at, 'HH:mm')
  if (period === 'Earlier this week' || period === 'Last week') return format(at, 'EEE HH:mm')
  return format(at, at.getFullYear() === now.getFullYear() ? 'd MMM' : 'd MMM yyyy')
}
