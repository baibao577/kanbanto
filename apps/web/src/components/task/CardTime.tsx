import { Timer, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { TimeEntryView } from '@kanbanto/model/api'
import { fromDay, todayDay, toDay } from '@kanbanto/model/dates'
import { descendantsOf } from '@kanbanto/model/indexer'
import { formatDuration, parseDuration } from '@kanbanto/model/time'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { dayWords } from '@/components/time/logging'
import { cn } from '@/lib/utils'
import { Section } from './Section'

/** The side field: the card's logged time (with its subtasks') and a way to log more. */
export function TimeField({ taskId }: { taskId: string }) {
  const { counts, idx, logTime } = useBoard()
  const own = counts.time[taskId] ?? 0
  const all = own + descendantsOf(idx, taskId).reduce((s, k) => s + (counts.time[k] ?? 0), 0)
  return (
    <div className="flex min-h-8 items-center gap-2 px-2 py-1 text-sm">
      <span className={cn('min-w-0 tabular-nums', !all && 'text-muted-foreground')}>
        {own ? formatDuration(own) : all ? 'None on this card' : 'None yet'}
        {all > own && <span className="block text-xs text-muted-foreground">{formatDuration(all)} with subtasks</span>}
      </span>
      {logTime && (
        <button
          type="button"
          onClick={() => logTime(taskId)}
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10"
        >
          <Timer className="size-3.5" /> Log
        </button>
      )}
    </div>
  )
}

/** The card's time, by person: each entry's time, day and note, changed in place by whoever may. */
export function TimeSection({ taskId }: { taskId: string }) {
  const { data, onActivity } = useBoard()
  const me = useAuth().user?.id
  const boardId = data.board.id
  const [entries, setEntries] = useState<TimeEntryView[]>([])
  const load = useCallback(() => {
    api<{ entries: TimeEntryView[] }>('GET', `/boards/${boardId}/tasks/${taskId}/time`).then(
      (r) => setEntries(r.entries),
      () => setEntries([]),
    )
  }, [boardId, taskId])
  useEffect(load, [load])
  // Logged, changed or removed here or by someone else: the card's list follows.
  useEffect(() => onActivity((m) => m.type === 'time' && m.taskId === taskId && load()), [onActivity, taskId, load])

  if (!entries.length) return null
  const people = new Map<string, { name: string; entries: TimeEntryView[]; total: number }>()
  for (const e of entries) {
    const key = e.user?.id ?? ''
    const p = people.get(key) ?? { name: e.user?.name ?? 'Someone who left', entries: [], total: 0 }
    p.entries.push(e)
    p.total += e.minutes
    people.set(key, p)
  }
  const total = entries.reduce((s, e) => s + e.minutes, 0)

  const change = (e: TimeEntryView, fields: Partial<Pick<TimeEntryView, 'minutes' | 'day' | 'note'>>) =>
    api('PATCH', `/boards/${boardId}/time/${e.id}`, fields).then(load, (err) => toast.error(errorMessage(err)))
  const remove = (e: TimeEntryView, mine: boolean) =>
    api('DELETE', `/boards/${boardId}/time/${e.id}`).then(
      () => {
        load()
        // Your own comes back with Undo; someone else's was confirmed first.
        if (mine)
          toast(`Removed ${formatDuration(e.minutes)}`, {
            action: {
              label: 'Undo',
              onClick: () =>
                void api('POST', `/boards/${boardId}/tasks/${taskId}/time`, { minutes: e.minutes, day: e.day, note: e.note }).then(load, (err) =>
                  toast.error(errorMessage(err)),
                ),
            },
          })
      },
      (err) => toast.error(errorMessage(err)),
    )

  return (
    <Section icon={<Timer />} title="Time" aside={<span className="text-sm font-medium tabular-nums">{formatDuration(total)}</span>}>
      <div className="space-y-3">
        {[...people.entries()].map(([key, p]) => (
          <div key={key}>
            <div className="mb-1 flex items-center gap-2 text-sm">
              <Avatar name={p.name} className="size-5 text-[9px]" />
              <span className="font-medium">{p.name}</span>
              <span className="text-muted-foreground tabular-nums">{formatDuration(p.total)}</span>
            </div>
            <ul className="ml-7">
              {p.entries.map((e) => (
                <EntryRow key={e.id} entry={e} mine={e.user?.id === me} onChange={(f) => change(e, f)} onRemove={(mine) => remove(e, mine)} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  )
}

function EntryRow({
  entry: e,
  mine,
  onChange,
  onRemove,
}: {
  entry: TimeEntryView
  /** Yours: removing it can be undone (someone else's is confirmed first instead). */
  mine: boolean
  onChange: (fields: Partial<Pick<TimeEntryView, 'minutes' | 'day' | 'note'>>) => void
  onRemove: (mine: boolean) => void
}) {
  const [editing, setEditing] = useState<'minutes' | 'day' | 'note' | null>(null)
  const [armed, setArmed] = useState(false)
  const field = 'h-7 rounded px-1.5 text-left hover:bg-accent disabled:hover:bg-transparent'
  const done = () => setEditing(null)

  return (
    <li className="group flex min-h-8 items-center gap-1 text-sm">
      {editing === 'minutes' ? (
        <input
          autoFocus
          defaultValue={formatDuration(e.minutes)}
          aria-label="Time"
          className="h-7 w-20 rounded border bg-background px-1.5 tabular-nums"
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.stopPropagation()
              done()
            } else if (ev.key === 'Enter') ev.currentTarget.blur()
          }}
          onBlur={(ev) => {
            const m = parseDuration(ev.currentTarget.value)
            done()
            if (m === null) return void (ev.currentTarget.value.trim() && toast.error('Type a time, like 1h 30m or 45m.'))
            if (typeof m !== 'number') return void toast.error(m.error)
            if (m !== e.minutes) onChange({ minutes: m })
          }}
        />
      ) : (
        <button type="button" disabled={!e.canEdit} onClick={() => setEditing('minutes')} className={cn(field, 'w-20 font-medium tabular-nums')}>
          {formatDuration(e.minutes)}
        </button>
      )}
      {editing === 'day' ? (
        <input
          type="date"
          autoFocus
          defaultValue={e.day}
          max={fromDay(todayDay())}
          aria-label="Day"
          className="h-7 rounded border bg-background px-1.5"
          onKeyDown={(ev) => ev.key === 'Escape' && (ev.stopPropagation(), done())}
          onBlur={(ev) => {
            const v = ev.currentTarget.value
            done()
            if (v && v !== e.day) onChange({ day: v })
          }}
        />
      ) : (
        <button type="button" disabled={!e.canEdit} onClick={() => setEditing('day')} className={cn(field, 'w-28 text-muted-foreground')}>
          {dayWords(toDay(e.day))}
        </button>
      )}
      {editing === 'note' ? (
        <input
          autoFocus
          defaultValue={e.note}
          maxLength={200}
          aria-label="Note"
          className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5"
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.stopPropagation()
              done()
            } else if (ev.key === 'Enter') ev.currentTarget.blur()
          }}
          onBlur={(ev) => {
            const v = ev.currentTarget.value.trim()
            done()
            if (v !== e.note) onChange({ note: v })
          }}
        />
      ) : (
        <button
          type="button"
          disabled={!e.canEdit}
          onClick={() => setEditing('note')}
          className={cn(field, 'min-w-0 flex-1 truncate', !e.note && 'text-muted-foreground/60')}
        >
          {e.note || (e.canEdit ? 'Add a note' : '')}
        </button>
      )}
      {e.editedBy && <span className="shrink-0 text-xs text-muted-foreground">edited by {e.editedBy.name}</span>}
      {e.canEdit &&
        (armed ? (
          <button
            type="button"
            className="h-7 shrink-0 rounded px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
            onClick={() => onRemove(false)}
          >
            Remove?
          </button>
        ) : (
          <button
            type="button"
            aria-label="Remove"
            title="Remove"
            onClick={() => (mine ? onRemove(true) : setArmed(true))}
            className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 touch-only:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        ))}
    </li>
  )
}
