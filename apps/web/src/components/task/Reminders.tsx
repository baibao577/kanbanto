import { Alarm, Plus, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { useBoard } from '@/app/board-context'
import { useAuth } from '@/app/use-auth'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { parseWhen } from '@/lib/when'
import { newId } from '@kanbanto/model/ids'
import { fireTime } from '@kanbanto/model/reminders'
import type { Reminder, Task } from '@kanbanto/model/types'

/** A moment as a reminder's `at`: UTC, to the minute. */
const moment = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const BEFORE_DUE = [
  { label: '1 hour before', minutes: 60 },
  { label: '1 day before', minutes: 24 * 60 },
  { label: '2 days before', minutes: 2 * 24 * 60 },
]
/** The time now, to the minute (so "went off" updates while the card is open). */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

const beforeWords = (m: number) => BEFORE_DUE.find((b) => b.minutes === m)?.label ?? `${m} minutes before`

/**
 * A card's reminders: each goes off once, for whoever is assigned then (or whoever set it, if nobody is), under the
 * bell and by email. Added by typing a time in plain words ("tmr 10:00", "fri 2pm"), a quick pick, or "before it's
 * due" (which follows the due date).
 */
export function Reminders({ task, readOnly, onChange }: { task: Task; readOnly: boolean; onChange: (reminders: Reminder[]) => void }) {
  const { memberName } = useBoard()
  const { user } = useAuth()
  const list = [...(task.reminders ?? [])]
    .map((r) => ({ r, at: fireTime(r, task) }))
    .sort((a, b) => (a.at?.getTime() ?? Infinity) - (b.at?.getTime() ?? Infinity))
  const add = (r: Omit<Reminder, 'id' | 'by'>) => onChange([...(task.reminders ?? []), { id: newId(), ...r, ...(user && { by: user.id }) }])
  const remove = (id: string) => onChange((task.reminders ?? []).filter((r) => r.id !== id))
  const forWhom = task.assigneeId ? memberName(task.assigneeId) : null
  const now = useNow()

  return (
    <div className="space-y-1 px-1">
      {list.map(({ r, at }) => {
        const past = at && at.getTime() <= now
        return (
          <div key={r.id} className={cn('group/rem flex min-h-7 items-start gap-2 rounded px-1 py-1 text-sm', past && 'text-muted-foreground')}>
            <Alarm className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1" title={at?.toString()}>
              <span className="block truncate">
                {at ? formatDay(at.toISOString(), true) : 'Needs a due date'}
                {past && ' · went off'}
              </span>
              {r.beforeDue !== undefined && <span className="block text-xs text-muted-foreground">{beforeWords(r.beforeDue)} it’s due</span>}
            </span>
            {!readOnly && (
              <button
                type="button"
                aria-label="Remove this reminder"
                onClick={() => remove(r.id)}
                className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 group-hover/rem:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        )
      })}
      {list.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">For {forWhom ? forWhom : 'whoever set it (nobody is assigned)'}.</p>}
      {!readOnly && <AddReminder task={task} onAdd={add} />}
      {readOnly && !list.length && <p className="px-1 text-sm text-muted-foreground">None</p>}
    </div>
  )
}

function AddReminder({ task, onAdd }: { task: Task; onAdd: (r: Omit<Reminder, 'id' | 'by'>) => void }) {
  const [open, setOpen] = useState(false)
  // The quick picks count from when the picker opened.
  const [base, setBase] = useState(() => new Date())
  const [words, setWords] = useState('')
  const when = words.trim() ? parseWhen(words) : null
  const at = (d: Date) => {
    onAdd({ at: moment(d) })
    setOpen(false)
    setWords('')
  }
  const today = (h: number) => {
    const d = new Date(base)
    d.setHours(h, 0, 0, 0)
    return d
  }
  const inDays = (days: number, h: number) => {
    const d = today(h)
    d.setDate(d.getDate() + days)
    return d
  }
  const nextMonday = () => inDays((8 - base.getDay()) % 7 || 7, 9)
  const picks = [
    { label: 'In 1 hour', date: new Date(base.getTime() + 3_600_000) },
    ...(base.getHours() < 18 ? [{ label: 'This evening', date: today(18) }] : []),
    { label: 'Tomorrow morning', date: inDays(1, 9) },
    { label: 'Next Monday', date: nextMonday() },
  ]
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setBase(new Date())
        else setWords('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded px-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" /> Add a reminder
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <form
          className="border-b p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (when) at(when.date)
          }}
        >
          <input
            autoFocus
            value={words}
            onChange={(e) => setWords(e.target.value)}
            placeholder="e.g. tmr 10:00, fri 2pm, in 2 hours"
            aria-label="When"
            className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <p className={cn('mt-1.5 px-1 text-xs', when ? 'text-foreground' : 'text-muted-foreground')}>
            {words.trim() ? (
              when ? (
                <>
                  ⏰ {formatDay(moment(when.date), true)} · <span className="text-muted-foreground">Enter to add</span>
                </>
              ) : (
                'Not a time I know: try “tomorrow 9am” or “fri 14:00”.'
              )
            ) : (
              'Type a time, or pick one below.'
            )}
          </p>
        </form>
        <div className="p-1">
          {picks.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => at(p.date)}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              {p.label}
              <span className="text-xs text-muted-foreground">{formatDay(moment(p.date), true)}</span>
            </button>
          ))}
        </div>
        <div className="border-t p-1">
          <p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">
            {task.due ? 'Before it’s due (moves with the due date)' : 'Before it’s due: set a due date first'}
          </p>
          {BEFORE_DUE.map((b) => (
            <button
              key={b.minutes}
              type="button"
              disabled={!task.due}
              onClick={() => {
                onAdd({ beforeDue: b.minutes, tz })
                setOpen(false)
              }}
              className="flex w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
            >
              {b.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
