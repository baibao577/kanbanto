import { useMemo, useState } from 'react'
import { useAuth } from '@/app/use-auth'
import { parseWhen, type When } from '@/lib/when'
import type { TaskFields } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'

/** A reminder's `at` / a due moment: UTC, to the minute. */
export const moment = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
/** A whole day in the viewer's time zone. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * A time typed into a new card's title ("buy cat next monday 1pm"): found as you type, shown as a chip, and on add
 * taken out of the title and set as the due date (and, if chosen, a reminder). ✕ ignores it for this card.
 */
export function useTitleDate(value: string) {
  const { user } = useAuth()
  const [ignored, setIgnored] = useState<string | null>(null)
  const [remind, setRemind] = useState(false)
  const found = useMemo(() => (value.trim() ? parseWhen(value) : null), [value])
  // Ignoring sticks to those words; typing a different time brings the chip back.
  const when = found && found.text !== ignored ? found : null

  /** The title without the time's words, and the fields they set. Nothing changes when there's no time (or it was ignored). */
  const apply = (title: string): { title: string; fields: TaskFields } => {
    if (!when) return { title, fields: {} }
    const left = stripWords(title, when)
    if (!left) return { title, fields: {} }
    const due = when.timed ? moment(when.date) : localDay(when.date)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const reminder = when.timed ? { id: newId(), at: due } : { id: newId(), beforeDue: 0, tz }
    return { title: left, fields: { due, ...(remind && { reminders: [{ ...reminder, ...(user && { by: user.id }) }] }) } }
  }
  const reset = () => {
    setIgnored(null)
    setRemind(false)
  }
  return { when, remind, setRemind, ignore: () => when && setIgnored(when.text), apply, reset }
}

/** The title with the time's words (and a leftover "on"/"at"/"by"/"due") taken out. */
function stripWords(title: string, when: When): string {
  const before = title.slice(0, when.index).replace(/\s+(on|at|by|due)\s*$/i, '')
  return `${before} ${title.slice(when.index + when.text.length)}`.replace(/\s{2,}/g, ' ').replace(/^[\s,–-]+|[\s,–-]+$/g, '')
}
