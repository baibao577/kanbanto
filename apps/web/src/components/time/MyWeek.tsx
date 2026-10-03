import { ArrowLeft, CaretLeft, CaretRight, MagnifyingGlass, Plus, Timer } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { CardsPage, TimeEntryView, WeekView } from '@kanbanto/model/api'
import { fromDay, isWeekend, mondayOf, todayDay, toDay } from '@kanbanto/model/dates'
import { formatDuration, formatHours, parseDuration } from '@kanbanto/model/time'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { LogoMark } from '@/components/common/Logo'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { zone } from './logging'

type Card = WeekView['cards'][number]
const key = (c: { boardId: string; taskId: string }) => `${c.boardId}:${c.taskId}`
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Monday to Sunday: "28 Sep – 4 Oct", or "21 – 27 Sep" within one month; the year when it isn't this one. */
function weekRange(monday: number) {
  const parts = (d: number) => {
    const t = new Date(d * 86_400_000)
    return { day: t.getUTCDate(), month: t.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), year: t.getUTCFullYear() }
  }
  const a = parts(monday)
  const b = parts(monday + 6)
  const year = b.year !== new Date().getFullYear() ? ` ${b.year}` : ''
  if (a.month === b.month) return `${a.day} – ${b.day} ${b.month}${year}`
  return `${a.day} ${a.month}${a.year !== b.year ? ` ${a.year}` : ''} – ${b.day} ${b.month}${year}`
}

/**
 * My week: your time on every board, a card per row and a day per column, typed in like a spreadsheet. Dots mark the
 * days you worked on a card (moved it, changed it, commented); the hours are always yours to type.
 */
export default function MyWeek({ week }: { week?: string }) {
  const today = todayDay()
  const monday = week ? mondayOf(toDay(week)) : mondayOf(today)
  const [view, setView] = useState<WeekView | null>(null)
  const [added, setAdded] = useState<Card[]>([])
  const load = useCallback(() => {
    api<WeekView>('GET', `/time/week?from=${fromDay(monday)}&timeZone=${encodeURIComponent(zone())}`).then(setView, (e) =>
      toast.error(errorMessage(e)),
    )
  }, [monday])
  useEffect(load, [load])
  useEffect(() => {
    document.title = 'My week · Kanbanto'
  }, [])

  const days = useMemo(() => {
    const all = Array.from({ length: 7 }, (_, i) => monday + i)
    // The weekend only when there's time on it.
    return all.filter((d) => !isWeekend(d) || view?.entries.some((e) => toDay(e.day) === d))
  }, [monday, view])
  const cards = useMemo(() => {
    const list = [...(view?.cards ?? [])]
    for (const c of added) if (!list.some((x) => key(x) === key(c))) list.push(c)
    // Grouped by board, in the order boards first appear.
    const order = [...new Set(list.map((c) => c.boardId))]
    let row = 0
    return order.map((b) => ({
      boardId: b,
      name: list.find((c) => c.boardId === b)!.boardName,
      // Each card's row number, for moving between cells with the keyboard.
      cards: list.filter((c) => c.boardId === b).map((c) => ({ ...c, row: row++ })),
    }))
  }, [view, added])
  const cell = useMemo(() => {
    const m = new Map<string, TimeEntryView[]>()
    for (const e of view?.entries ?? []) {
      const k = `${e.boardId}:${e.taskId}:${e.day}`
      m.set(k, [...(m.get(k) ?? []), e])
    }
    return m
  }, [view])
  const hours = view?.hoursPerDay ?? 8
  const dayTotal = (d: number) => (view?.entries ?? []).filter((e) => toDay(e.day) === d).reduce((s, e) => s + e.minutes, 0)
  const weekTotal = (view?.entries ?? []).reduce((s, e) => s + e.minutes, 0)
  const workdays = days.filter((d) => !isWeekend(d))
  const target = workdays.length * hours * 60
  const go = (by: number) => navigate({ page: 'time', ...(monday + by * 7 !== mondayOf(today) && { week: fromDay(monday + by * 7) }) })

  /** A cell typed in: log, change or remove the time of that card on that day. */
  const commit = async (c: Card, d: number, text: string, entries: TimeEntryView[]) => {
    const t = text.trim()
    const now = entries.reduce((s, e) => s + e.minutes, 0)
    const m = t ? parseDuration(t) : 0
    if (m === null) return void toast.error('Type a time, like 2, 1:30 or 45m.')
    if (typeof m !== 'number') return void toast.error(m.error)
    if (m === now) return
    try {
      if (!entries.length) await api('POST', `/boards/${c.boardId}/tasks/${c.taskId}/time`, { minutes: m, day: fromDay(d), note: '' })
      else if (m) await api('PATCH', `/boards/${c.boardId}/time/${entries[0].id}`, { minutes: m })
      else {
        const e = entries[0]
        await api('DELETE', `/boards/${c.boardId}/time/${e.id}`)
        toast(`Removed ${formatDuration(e.minutes)} from ${c.title}`, {
          action: {
            label: 'Undo',
            onClick: () =>
              void api('POST', `/boards/${c.boardId}/tasks/${c.taskId}/time`, { minutes: e.minutes, day: e.day, note: e.note }).then(load, (err) =>
                toast.error(errorMessage(err)),
              ),
          },
        })
      }
    } catch (e) {
      toast.error(errorMessage(e))
    }
    load()
  }

  // Arrow keys and Enter move between cells, like a spreadsheet.
  const grid = useRef<HTMLTableElement>(null)
  const move = (row: number, col: number) => {
    const el = grid.current?.querySelector<HTMLInputElement>(`[data-cell="${row}:${col}"]`)
    if (el) {
      el.focus()
      el.select()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <a href={hrefFor({ page: 'home' })} className="grid size-8 place-items-center rounded-md hover:bg-accent" aria-label="Your boards">
          <LogoMark className="size-7" title="Your boards" />
        </a>
        <a href={hrefFor({ page: 'home' })} className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5 shrink-0" /> <span className="truncate">Boards</span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <AccountMenu />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
          <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Timer className="size-5" />
            </span>
            <div className="mr-auto min-w-0 sm:flex-1">
              <h1 className="text-lg font-semibold">My week</h1>
              <p className="text-xs text-muted-foreground">
                Your time on every board. Type hours in a cell: 2, 1:30 or 45m.{' '}
                <span className="inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-primary/50" /> a day you worked on the card (moved, changed or commented on it)
                </span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="Week before"
                onClick={() => go(-1)}
                className="grid size-8 place-items-center rounded-md border hover:bg-accent"
              >
                <CaretLeft className="size-4" />
              </button>
              <span className="min-w-36 text-center leading-tight">
                <span className="block text-sm font-medium tabular-nums">{weekRange(monday)}</span>
                {monday === mondayOf(today) && <span className="block text-[11px] text-muted-foreground">This week</span>}
              </span>
              <button
                type="button"
                aria-label="Week after"
                disabled={monday + 7 > today}
                onClick={() => go(1)}
                className="grid size-8 place-items-center rounded-md border hover:bg-accent disabled:opacity-40"
              >
                <CaretRight className="size-4" />
              </button>
            </div>
            <AddCard onAdd={(c) => setAdded((a) => [...a, c])} />
          </div>

          {/* How full the week is: logged against your working days. */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span>
                <b className="tabular-nums">{formatHours(weekTotal)}h</b> of {formatHours(target)}h logged
              </span>
              <span className="text-xs text-muted-foreground">{hours} hours a day</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.min(100, target ? (weekTotal / target) * 100 : 0)}%` }}
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table ref={grid} className="w-full min-w-[640px] border-collapse text-sm max-sm:min-w-[560px]">
              <thead>
                <tr className="border-b bg-muted/40 text-xs">
                  <th className="sticky left-0 z-10 w-[40%] bg-muted px-3 py-2 text-left font-medium text-muted-foreground max-sm:w-36">Card</th>
                  {days.map((d) => {
                    const total = dayTotal(d)
                    const gap = !isWeekend(d) && d <= today && total === 0
                    const full = !isWeekend(d) && total >= hours * 60
                    return (
                      <th key={d} className={cn('px-1 py-2 text-center font-medium', d === today && 'text-primary')}>
                        <div>
                          {DAY_NAMES[new Date(d * 86_400_000).getUTCDay()]} {new Date(d * 86_400_000).getUTCDate()}
                        </div>
                        <div
                          className={cn(
                            'mt-0.5 font-normal tabular-nums',
                            gap ? 'text-destructive' : full ? 'text-status-done' : 'text-muted-foreground',
                          )}
                          title={gap ? 'Nothing logged on this working day' : undefined}
                        >
                          {total ? formatDuration(total) : gap ? 'nothing' : '–'}
                          {!isWeekend(d) && <span className="opacity-60"> / {hours}h</span>}
                        </div>
                      </th>
                    )
                  })}
                  <th className="w-20 px-2 py-2 text-right font-medium text-muted-foreground">Total</th>
                </tr>
              </thead>
              <tbody>
                {view && !cards.length && (
                  <tr>
                    <td colSpan={days.length + 2} className="px-3 py-8 text-center text-muted-foreground">
                      Nothing yet this week. Add a card below, or log time from a board.
                    </td>
                  </tr>
                )}
                {cards.map((g) => (
                  <BoardRows key={g.boardId} name={g.name} boardId={g.boardId} days={days}>
                    {g.cards.map((c) => {
                      const r = c.row
                      const touched = new Set(view?.touched[key(c)] ?? [])
                      const rowTotal = days.reduce((s, d) => s + (cell.get(`${key(c)}:${fromDay(d)}`) ?? []).reduce((t, e) => t + e.minutes, 0), 0)
                      return (
                        <tr key={key(c)} className="border-b last:border-b-0 hover:bg-accent/30">
                          <td className="sticky left-0 z-10 max-w-0 bg-background px-3 py-1">
                            <a
                              href={hrefFor({ page: 'board', id: c.boardId, task: c.taskId })}
                              className={cn('block truncate hover:underline', c.done && 'text-muted-foreground')}
                              title={c.parent ? `${c.parent} › ${c.title}` : c.title}
                            >
                              {c.parent && <span className="text-muted-foreground max-sm:hidden">{c.parent} › </span>}
                              {c.title}
                            </a>
                          </td>
                          {days.map((d, col) => (
                            <td key={d} className="px-1 py-1">
                              <Cell
                                entries={cell.get(`${key(c)}:${fromDay(d)}`) ?? []}
                                touched={touched.has(fromDay(d))}
                                disabled={!c.canLog || d > today}
                                id={`${r}:${col}`}
                                card={c}
                                onCommit={(text, entries) => commit(c, d, text, entries)}
                                onMove={(dr, dc) => move(r + dr, col + dc)}
                              />
                            </td>
                          ))}
                          <td className="px-2 py-1 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                            {rowTotal ? formatDuration(rowTotal) : ''}
                          </td>
                        </tr>
                      )
                    })}
                  </BoardRows>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}

function BoardRows({ name, boardId, days, children }: { name: string; boardId: string; days: number[]; children: React.ReactNode }) {
  return (
    <>
      <tr className="border-b bg-muted/20">
        <td colSpan={days.length + 2} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
          <a href={hrefFor({ page: 'board', id: boardId })} className="hover:underline">
            {name}
          </a>
        </td>
      </tr>
      {children}
    </>
  )
}

/** One card on one day: type the time; a cell with several entries shows them instead. */
function Cell({
  entries,
  touched,
  disabled,
  id,
  card,
  onCommit,
  onMove,
}: {
  entries: TimeEntryView[]
  touched: boolean
  disabled: boolean
  id: string
  card: Card
  onCommit: (text: string, entries: TimeEntryView[]) => void
  onMove: (dRow: number, dCol: number) => void
}) {
  const total = entries.reduce((s, e) => s + e.minutes, 0)
  const shown = total ? formatDuration(total) : ''
  // What's being typed, while the cell has focus; otherwise it shows what's logged.
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? shown
  // Escape leaves the cell as it was.
  const cancelled = useRef(false)
  const base = 'h-8 w-full rounded-md text-center tabular-nums'

  if (entries.length > 1)
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={cn(base, 'border border-dashed hover:bg-accent')} title="Several entries">
            {shown}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 space-y-1 p-3 text-sm">
          {entries.map((e) => (
            <div key={e.id} className="flex gap-2">
              <span className="w-14 font-medium tabular-nums">{formatDuration(e.minutes)}</span>
              <span className="truncate text-muted-foreground">{e.note || 'no note'}</span>
            </div>
          ))}
          <a
            href={hrefFor({ page: 'board', id: card.boardId, task: card.taskId })}
            className="block pt-1 text-xs font-medium text-primary hover:underline"
          >
            Change them on the card
          </a>
        </PopoverContent>
      </Popover>
    )

  return (
    <div className="relative">
      {touched && !text && (
        <span
          className="pointer-events-none absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-primary/50"
          title="You worked on it this day"
        />
      )}
      <input
        data-cell={id}
        value={text}
        disabled={disabled}
        aria-label={`${card.title}, time`}
        title={touched ? 'You worked on this card this day' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(shown)
          e.currentTarget.select()
        }}
        onBlur={() => {
          if (!cancelled.current && draft !== null && draft !== shown) onCommit(draft, entries)
          cancelled.current = false
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            onMove(1, 0)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            onMove(-1, 0)
          } else if (e.key === 'Escape') {
            cancelled.current = true
            e.currentTarget.blur()
          }
        }}
        className={cn(
          base,
          'border border-transparent bg-transparent outline-none hover:border-border focus:border-ring focus:bg-background disabled:hover:border-transparent',
          text && 'font-medium',
        )}
      />
    </div>
  )
}

/** "+ Add a card": any card on your boards, to fill in (it stays once it has time). */
function AddCard({ onAdd }: { onAdd: (c: Card) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<CardsPage['cards']>([])
  useEffect(() => {
    if (!q.trim()) return
    const t = setTimeout(
      () =>
        api<CardsPage>('GET', `/cards?state=active&q=${encodeURIComponent(q.trim())}`).then(
          (r) => setHits(r.cards.filter((c) => !c.archived).slice(0, 8)),
          () => setHits([]),
        ),
      200,
    )
    return () => clearTimeout(t)
  }, [q])
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQ('')
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5">
          <Plus /> Add a card
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <MagnifyingGlass className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a card on your boards"
            className="h-10 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <ul className="max-h-64 overflow-y-auto py-1">
          {!q.trim() && <li className="px-3 py-2 text-sm text-muted-foreground">Type a card’s name.</li>}
          {(q.trim() ? hits : []).map((c) => (
            <li key={`${c.board.id}:${c.id}`}>
              <button
                type="button"
                onClick={() => {
                  onAdd({
                    boardId: c.board.id,
                    taskId: c.id,
                    title: c.title,
                    parent: c.path.at(-1) ?? null,
                    boardName: c.board.name,
                    done: c.done,
                    canLog: true,
                  })
                  setQ('')
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">
                  {c.path.length > 0 && <span className="text-muted-foreground">{c.path.join(' › ')} › </span>}
                  {c.title}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.board.name}</span>
              </button>
            </li>
          ))}
          {q.trim() && !hits.length && <li className="px-3 py-2 text-sm text-muted-foreground">No card by that name.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
