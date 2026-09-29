import { CalendarBlank, Check, UserCircle, UserPlus, X } from '@phosphor-icons/react'
import { parseISO } from 'date-fns'
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar } from '@/components/common/bits'
import { formatDay } from '@/lib/format'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { fromDay, toDay } from '@kanbanto/model/dates'
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

/** A date with a calendar popover and a clear button. */
export function DateField({ value, onChange, placeholder }: { value?: string; onChange: (iso: string | undefined) => void; placeholder: string }) {
  const [open, setOpen] = useState(false)
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
          <Suspense fallback={<div className="size-72" />}>
            <Calendar
              mode="single"
              selected={value ? parseISO(value) : undefined}
              defaultMonth={value ? parseISO(value) : undefined}
              onSelect={(d) => {
                if (!d) return
                // Calendar dates are local midnight; store the calendar day, not a UTC shift of it.
                onChange(fromDay(toDay(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)))
                setOpen(false)
              }}
            />
          </Suspense>
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

/** The button look shared by the dialog's side fields. */
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
