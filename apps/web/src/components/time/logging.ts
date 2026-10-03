import { toast } from 'sonner'
import type { TimeEntryView } from '@kanbanto/model/api'
import { fromDay, todayDay } from '@kanbanto/model/dates'
import { formatDuration } from '@kanbanto/model/time'
import { api, errorMessage } from '@/api/client'
import { formatDay } from '@/lib/format'

/** This device's time zone (the day you log for is your day). */
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** "Today", "Yesterday", or "Thu 2 Oct". */
export function dayWords(day: number) {
  const today = todayDay()
  if (day === today) return 'Today'
  if (day === today - 1) return 'Yesterday'
  return formatDay(fromDay(day), true)
}

/**
 * Logs time on a card and says so, with Undo. Returns the entry, or null if it was refused (the reason is shown).
 */
export async function logTime(
  boardId: string,
  taskId: string,
  title: string,
  body: { minutes: number; day: string; note: string },
  after?: () => void,
): Promise<TimeEntryView | null> {
  try {
    const { entry } = await api<{ entry: TimeEntryView }>('POST', `/boards/${boardId}/tasks/${taskId}/time`, body)
    const when = body.day === fromDay(todayDay()) ? '' : ` · ${formatDay(body.day, true)}`
    toast(`Logged ${formatDuration(body.minutes)} on ${title}${when}`, {
      action: {
        label: 'Undo',
        onClick: () =>
          void api('DELETE', `/boards/${boardId}/time/${entry.id}`).then(
            () => after?.(),
            (e) => toast.error(errorMessage(e)),
          ),
      },
    })
    after?.()
    return entry
  } catch (e) {
    toast.error(errorMessage(e))
    return null
  }
}

/** Minutes on each card with its subtasks', for cards that have subtasks. */
export function rollUp(own: Record<string, number>, childrenOf: ReadonlyMap<string, readonly string[]>) {
  const out = new Map<string, number>()
  const total = (id: string): number => {
    const known = out.get(id)
    if (known !== undefined) return known
    const sum = (own[id] ?? 0) + (childrenOf.get(id) ?? []).reduce((s, k) => s + total(k), 0)
    out.set(id, sum)
    return sum
  }
  return (id: string) => total(id)
}
