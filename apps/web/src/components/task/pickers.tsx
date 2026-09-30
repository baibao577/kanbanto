import { CalendarBlank, Check, Clock, UserCircle, UserPlus, X } from '@phosphor-icons/react'
import { parseISO } from 'date-fns'
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar } from '@/components/common/bits'
import { formatDay } from '@/lib/format'
import { parseWhen } from '@/lib/when'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { fromDay, localDayOf, localTimeOf, momentAt, parseTime, toDay, todayDay } from '@kanbanto/model/dates'
import { ancestorsOf } from '@kanbanto/model/indexer'

// The calendar (and its date library) loads the first time someone opens a date.
const Calendar = lazy(() => import('@/components/ui/calendar').then((m) => ({ default: m.Calendar })))

const MAX_RESULTS = 30

/** Search-as-you-type task picker. Scans the tree directly, so it stays fast with 50k tasks. */
export function TaskPicker({
  trigger,
  placeholder,
  onPick,
  exclude,
  noneLabel,
}: {
  trigger: ReactNode
  placeholder: string
  onPick: (id: string | null) => void
  exclude?: Set<string>
  /** Adds a "none" option at the top (e.g. "No parent — make it a project"). */
  noneLabel?: string
}) {
  const { idx } = useBoard()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const results = useMemo(() => {
    if (!open) return []
    const needle = q.trim().toLowerCase()
    const out: string[] = []
    for (const id of idx.preorder) {
      if (exclude?.has(id)) continue
      if (!needle || idx.tasks[id].title.toLowerCase().includes(needle)) {
        out.push(id)
        if (out.length >= MAX_RESULTS) break
      }
    }
    return out
  }, [open, q, idx, exclude])

  const pick = (id: string | null) => {
    onPick(id)
    setOpen(false)
    setQ('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>No tasks found.</CommandEmpty>
            {noneLabel && !q && (
              <CommandGroup>
                <CommandItem onSelect={() => pick(null)}>{noneLabel}</CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {results.map((id) => {
                const path = ancestorsOf(idx.tasks, id)
                return (
                  <CommandItem key={id} value={id} onSelect={() => pick(id)} className="flex-col items-start gap-0">
                    <span className="w-full truncate">{idx.tasks[id].title}</span>
                    {path.length > 0 && (
                      <span className="w-full truncate text-xs text-muted-foreground">{path.map((a) => idx.tasks[a].title).join(' › ')}</span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Pick one of the board's people (its members). `value` / `onChange` are their account ids. */
export function PersonPicker({ value, onChange }: { value?: string; onChange: (memberId: string | null) => void }) {
  const { data, openShare, access } = useBoard()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const typed = q.trim()
  const matches = data.members.filter((m) => m.name.toLowerCase().includes(typed.toLowerCase()))
  const current = data.members.find((m) => m.id === value)

  const pick = (id: string | null) => {
    onChange(id)
    setOpen(false)
    setQ('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FieldButton empty={!current}>
          {current ? (
            <>
              <Avatar name={current.name} className="size-5 text-[9px]" /> {current.name}
            </>
          ) : (
            <>
              <UserCircle className="size-4" /> Assign someone
            </>
          )}
        </FieldButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder="Name" />
          <CommandList>
            <CommandGroup>
              {matches.map((m) => (
                <CommandItem key={m.id} value={m.id} onSelect={() => pick(m.id)}>
                  <Avatar name={m.name} className="size-5 text-[9px]" /> {m.name}
                  {m.id === value && <Check className="ml-auto" />}
                </CommandItem>
              ))}
              {typed && !matches.length && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">No one called “{typed}” is on this board.</div>
              )}
              {current && (
                <CommandItem value="none" onSelect={() => pick(null)} className="text-muted-foreground">
                  <X /> Remove assignee
                </CommandItem>
              )}
            </CommandGroup>
            {access.role === 'owner' && (
              <CommandGroup>
                <CommandItem
                  value="invite"
                  onSelect={() => {
                    setOpen(false)
                    openShare()
                  }}
                  className="text-muted-foreground"
                >
                  <UserPlus /> Invite people…
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Half-hour times for the time list, 00:00 to 23:30. */
const SLOTS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`)
const today = () => fromDay(todayDay())

/**
 * A date with a calendar popover and a clear button. A time is optional (24-hour, in your time zone): "Add time" under
 * the calendar; without one it's a whole day. `defaultTime` is what "Add time" starts with.
 */
/**
 * Typing a date in plain words ("tmr", "fri 2pm", "next monday", "12 oct"), above the calendar: Enter sets it. With a
 * time it's a moment; without, the whole day.
 */
function TypedDate({ onPick }: { onPick: (iso: string) => void }) {
  const [words, setWords] = useState('')
  const when = words.trim() ? parseWhen(words) : null
  const iso = when
    ? when.timed
      ? momentAt(localDay(when.date), `${pad(when.date.getHours())}:${pad(when.date.getMinutes())}`)
      : localDay(when.date)
    : null
  return (
    <form
      className="border-b p-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (iso) onPick(iso)
      }}
    >
      <input
        autoFocus
        value={words}
        onChange={(e) => setWords(e.target.value)}
        placeholder="Type a date: tmr, fri 2pm, 12 oct"
        aria-label="Type a date"
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      {words.trim() && (
        <p className="mt-1.5 px-1 text-xs text-muted-foreground">
          {iso ? (
            <>
              <span className="text-foreground">{formatDay(iso, true)}</span> · Enter to set
            </>
          ) : (
            'Not a date I know: try “tomorrow” or “fri 14:00”.'
          )}
        </p>
      )}
    </form>
  )
}
const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function DateField({
  value,
  onChange,
  placeholder,
  defaultTime = '09:00',
}: {
  value?: string
  onChange: (iso: string | undefined) => void
  placeholder: string
  defaultTime?: string
}) {
  const [open, setOpen] = useState(false)
  const day = value ? localDayOf(value) : undefined
  const time = value ? localTimeOf(value) : null
  const at = (d: string, t: string | null) => (t ? momentAt(d, t) : d)
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <FieldButton empty={!value} className="flex-1">
            <CalendarBlank className="size-4" />
            {value ? formatDay(value, true) : placeholder}
          </FieldButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <TypedDate
            onPick={(iso) => {
              onChange(iso)
              setOpen(false)
            }}
          />
          <Suspense fallback={<div className="size-72" />}>
            <Calendar
              mode="single"
              selected={day ? parseISO(day) : undefined}
              defaultMonth={day ? parseISO(day) : undefined}
              onSelect={(d) => {
                if (!d) return
                // Calendar dates are local midnight; keep the calendar day (and the time, if there is one).
                onChange(at(fromDay(toDay(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)), time))
                if (!time) setOpen(false)
              }}
            />
          </Suspense>
          <div className="border-t px-3 py-2">
            {time ? (
              <TimeField value={time} onChange={(t) => onChange(momentAt(day ?? today(), t))} onRemove={() => day && onChange(day)} />
            ) : (
              <button
                onClick={() => onChange(momentAt(day ?? today(), defaultTime))}
                className="flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Clock className="size-4" /> Add time
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value && (
        <button
          onClick={() => onChange(undefined)}
          aria-label="Clear date"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** A 24-hour time: type it ("1430", "9", "9.15") or pick a half hour from the list. */
function TimeField({ value, onChange, onRemove }: { value: string; onChange: (time: string) => void; onRemove: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const bad = draft !== null && parseTime(draft) === null
  const commit = () => {
    if (draft === null) return
    const t = parseTime(draft)
    if (t) onChange(t)
    setDraft(null)
  }
  // The list opens at the nearest half hour.
  const [h, m] = value.split(':').map(Number)
  const nearest = SLOTS[Math.min(47, h * 2 + Math.round(m / 30))]
  return (
    <div className="flex items-center gap-1.5">
      <Clock className="size-4 shrink-0 text-muted-foreground" />
      <input
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation()
            setDraft(null)
          }
        }}
        aria-label="Time (24-hour)"
        aria-invalid={bad}
        inputMode="numeric"
        className={cn(
          'h-8 w-16 rounded-md border bg-transparent px-2 text-center font-mono text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          bad && 'border-destructive focus-visible:ring-destructive/40',
        )}
      />
      <Select value={nearest} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-8 w-9 justify-center px-0 *:data-[slot=select-value]:hidden" aria-label="Choose a time">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-60" position="popper" align="start">
          {SLOTS.map((s) => (
            <SelectItem key={s} value={s} className="font-mono tabular-nums">
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        onClick={onRemove}
        className="ml-auto h-8 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Make it a whole day again"
      >
        Remove time
      </button>
    </div>
  )
}

export function FieldButton({ empty, className, children, ...props }: React.ComponentProps<'button'> & { empty?: boolean }) {
  return (
    <button
      {...props}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-2 truncate rounded-md px-2 text-left text-sm transition-colors hover:bg-accent',
        empty && 'text-muted-foreground',
        className,
      )}
    >
      {children}
    </button>
  )
}
