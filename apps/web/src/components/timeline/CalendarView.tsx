import { CaretLeft, CaretRight, Plus } from '@phosphor-icons/react'
import { format } from 'date-fns'
import { useMemo, useState, type DragEvent } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar, PriorityIcon, StatusDot } from '@/components/common/bits'
import { FilterMenu } from '@/components/shell/FilterMenu'
import { PresetMenu } from '@/components/shell/PresetMenu'
import { ViewActions } from '@/components/shell/ViewBar'
import { localDay } from '@/components/text/useTitleDate'
import { HiddenDoneNote } from '@/components/tree/HiddenDone'
import { useTreeFilter } from '@/components/tree/useTreeFilter'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { cn } from '@/lib/utils'
import { cardOnDay } from '@/lib/dayCard'
import { statusTone, tone } from '@kanbanto/model/colors'
import { dayParts, fromDay, mondayOf, shiftDays, toDay, todayDay } from '@kanbanto/model/dates'
import { dayCards, datedCards, monthWeeks, weekRows, type DayCard, type WeekRow } from '@kanbanto/model/dayGrid'
import { descendantsOf, statusCol } from '@kanbanto/model/indexer'
import { CALENDAR_RANGES, type CalendarRange, type TimelineConfig } from '@kanbanto/model/prefs'
import { treeTop } from '@kanbanto/model/tree'
import { TimelineDisplayMenu, TimelineRow } from './TimelineBar'

const RANGE_LABEL: Record<CalendarRange, string> = { day: 'Day', week: 'Week', '2w': '2 weeks', month: 'Month' }
/** Cards a day shows before "+ more" (none: all of them). A week has the height for every card. */
const MAX: Record<CalendarRange, number> = { day: 0, week: 0, '2w': 8, month: 5 }
/** How tall a day is at least. A week of days grows past it when its cards need the room. */
const CELL_H: Record<CalendarRange, string> = { day: '', week: '26rem', '2w': '14rem', month: '8.5rem' }
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** What a dragged card carries: its id, and (a bar) the day it was held by. */
const DRAG = 'application/x-kanbanto-day'

/** The day a day number is, as a date on this computer's clock (for writing it out). */
const dateOf = (day: number) => {
  const p = dayParts(day)
  return new Date(p.year, p.month, p.date)
}

/**
 * The Timeline as a calendar: each day with the cards that are on it. A card is on the day it is due (or starts),
 * with its time when it has one; one with a start and a due date runs across its days. A day, a week, two weeks or
 * a month at a time. Drag a card to another day to change its date, press + on a day to add one, click a day's
 * number to see that day alone. On a phone, a month is dots with the picked day's cards under it, and weeks are a
 * list day by day.
 */
export function CalendarView({ search }: { search: string }) {
  const { data, prefs, setPrefs, idx, run, openTask, createTask, readOnly, memberName } = useBoard()
  const cfg = useMemo<TimelineConfig>(() => prefs.timeline ?? {}, [prefs.timeline])
  const range = cfg.range ?? 'month'
  const subtasks = !!cfg.subtasks
  const set = (next: Partial<TimelineConfig>) => setPrefs({ type: 'setTimeline', config: { ...cfg, ...next } })
  const narrow = useMediaQuery('(max-width: 767px)')
  const today = todayDay()
  // A day inside what is shown (the month, the week); on a phone's month, the day whose cards are listed.
  const [at, setAt] = useState(today)
  const [adding, setAdding] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const focusId = prefs.focusId && prefs.focusId in data.tasks ? prefs.focusId : undefined
  const { top, baseDepth } = treeTop(idx, focusId)
  // Search, filters and "Hide done" (shared with the other tabs): the cards that pass them themselves.
  const { counted, hiddenDone } = useTreeFilter(search)
  const { cards, undated, hiddenSubtasks } = useMemo(() => {
    const passes = (id: string) => !counted || counted.has(id)
    const firsts = top.filter(passes)
    const under = top.flatMap((id) => descendantsOf(idx, id)).filter(passes)
    const shown = subtasks ? [...firsts, ...under] : firsts
    const cards = datedCards(idx, shown)
    return { cards, undated: shown.length - cards.length, hiddenSubtasks: subtasks ? 0 : datedCards(idx, under).length }
  }, [idx, top, counted, subtasks])

  const { first, weeks } = range === 'month' ? monthWeeks(at) : { first: mondayOf(at), weeks: range === '2w' ? 2 : 1 }
  const rows = useMemo(() => (range === 'day' ? [] : weekRows(cards, first, weeks)), [cards, first, weeks, range])
  const month = range === 'month' ? dayParts(at).month : null

  const step = (dir: 1 | -1) => {
    if (range === 'month') {
      const p = dayParts(at)
      const to = new Date(p.year, p.month + dir, 1)
      setAt(toDay(localDay(to)))
    } else setAt(at + dir * (range === 'day' ? 1 : range === 'week' ? 7 : 14))
    setAdding(null)
  }
  const openDay = (day: number) => {
    setAt(day)
    setAdding(null)
    set({ range: 'day' })
  }
  const title =
    range === 'month'
      ? format(dateOf(at), 'MMMM yyyy')
      : range === 'day'
        ? format(dateOf(at), 'EEEE d MMMM yyyy')
        : `${format(dateOf(first), 'd MMM')} to ${format(dateOf(first + weeks * 7 - 1), 'd MMM yyyy')}`

  /** Moves a card by whole days: its start and its due date alike, each keeping its time. */
  const move = (id: string, days: number) => {
    const t = data.tasks[id]
    if (!t || !days) return
    run({ type: 'task.update', id, fields: { ...(t.start && { start: shiftDays(t.start, days) }), ...(t.due && { due: shiftDays(t.due, days) }) } })
  }
  const drop = (e: DragEvent, day: number) => {
    const [id, held] = e.dataTransfer.getData(DRAG).split('|')
    setOver(null)
    if (!id) return
    e.preventDefault()
    move(id, day - Number(held))
  }
  /** A new card on a day (a time of day in its title becomes its time: see `cardOnDay`). Nobody is assigned. */
  const add = (day: number, text: string) => text.trim() && createTask(focusId ?? null, cardOnDay(text, day))

  const draw: Draw = {
    idx,
    baseDepth,
    readOnly,
    memberName,
    openTask,
    held: (e, id, day) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(DRAG, `${id}|${day}`)
    },
  }
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards])
  const list = range === 'day' || (narrow && range === 'month') ? dayCards(cards, at) : null
  const boxed = range === 'day'

  return (
    <>
      <ViewActions>
        <PresetMenu />
        <FilterMenu />
        <TimelineDisplayMenu calendar />
      </ViewActions>

      <div className="flex h-full flex-col">
        <TimelineRow
          right={
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={range}
              onValueChange={(v) => v && set({ range: v as CalendarRange })}
              aria-label="How much time to show"
            >
              {CALENDAR_RANGES.map((r) => (
                <ToggleGroupItem key={r} value={r} className="px-2.5 sm:px-3">
                  {RANGE_LABEL[r]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        >
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="size-8" aria-label="Earlier" onClick={() => step(-1)}>
              <CaretLeft />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => {
                setAt(today)
                setAdding(null)
              }}
            >
              Today
            </Button>
            <Button variant="outline" size="icon" className="size-8" aria-label="Later" onClick={() => step(1)}>
              <CaretRight />
            </Button>
          </div>
          <h2 className="min-w-0 text-base font-semibold" aria-live="polite">
            {title}
          </h2>
        </TimelineRow>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full flex-col gap-3 px-3 pb-3 sm:px-6 sm:pb-4">
            {range !== 'day' && !narrow && (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="grid grid-cols-7 border-b bg-muted/50 text-xs font-medium text-foreground/80">
                  {WEEKDAYS.map((d) => (
                    <span key={d} className="px-3 py-1.5 text-right">
                      {d}
                    </span>
                  ))}
                </div>
                {rows.map((week) => (
                  <Week
                    key={week.first}
                    week={week}
                    draw={draw}
                    byId={byId}
                    month={month}
                    today={today}
                    max={MAX[range]}
                    roomy={range !== 'month'}
                    minHeight={CELL_H[range]}
                    over={over}
                    adding={adding}
                    onOver={setOver}
                    onDrop={drop}
                    onOpenDay={openDay}
                    onAdding={setAdding}
                    onAdd={add}
                  />
                ))}
              </div>
            )}

            {/* A phone: a month is its days as dots, with the picked day's cards under it. */}
            {range === 'month' && narrow && (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="grid grid-cols-7 border-b bg-muted/50 text-center text-[11px] font-medium text-foreground/80">
                  {WEEKDAYS.map((d) => (
                    <span key={d} className="py-1">
                      {d}
                    </span>
                  ))}
                </div>
                {rows.map((week) => (
                  <div key={week.first} className="grid grid-cols-7 border-b last:border-b-0">
                    {week.days.map((ids, i) => {
                      const day = week.first + i
                      const all = [...week.bars.filter((b) => b.from <= i && b.to >= i).map((b) => b.id), ...ids]
                      return (
                        <button
                          key={day}
                          onClick={() => setAt(day)}
                          aria-label={`${format(dateOf(day), 'EEEE d MMMM')}: ${all.length} ${all.length === 1 ? 'card' : 'cards'}`}
                          aria-pressed={day === at}
                          className={cn(
                            'flex h-12 flex-col items-center gap-1 border-r pt-1.5 last:border-r-0 aria-pressed:bg-accent',
                            dayParts(day).month !== month && 'bg-muted/40 text-muted-foreground',
                          )}
                        >
                          <span
                            className={cn(
                              'grid h-5 min-w-5 place-items-center rounded-full px-1 text-xs font-medium tabular-nums',
                              day === today && 'bg-primary font-semibold text-primary-foreground',
                            )}
                          >
                            {dayParts(day).date}
                          </span>
                          <span className="flex h-2 items-center gap-0.5">
                            {all.slice(0, 3).map((id) => (
                              <StatusDot key={id} category={statusCol(idx, id).category} color={statusCol(idx, id).color} className="size-1.5" />
                            ))}
                            {all.length > 3 && <span className="text-[9px] leading-none text-muted-foreground">+{all.length - 3}</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}

            {/* A phone: a week (or two) is a list, day by day. */}
            {(range === 'week' || range === '2w') && narrow && (
              <div className="flex flex-col gap-1">
                {rows.flatMap((week) =>
                  week.days.map((_, i) => {
                    const day = week.first + i
                    const of = dayCards(cards, day)
                    return (
                      <section key={day} className="flex flex-col gap-2">
                        <button
                          onClick={() => openDay(day)}
                          className={cn('mt-2 self-start text-xs font-medium text-muted-foreground', day === today && 'font-semibold text-primary')}
                        >
                          {format(dateOf(day), 'EEEE d MMM')}
                          {day === today && ' · today'}
                        </button>
                        {of.long.map((id) => (
                          <Row key={id} card={byId.get(id)!} draw={draw} />
                        ))}
                        {of.cards.map((c) => (
                          <Row key={c.id} card={c} draw={draw} />
                        ))}
                        {!of.long.length && !of.cards.length && <p className="text-xs text-muted-foreground/70">Nothing.</p>}
                      </section>
                    )
                  }),
                )}
              </div>
            )}

            {/* One day. On its own (Day) it is a box in the middle of the page, like one column of the week's grid with
              room for each card's details; under a phone's month it is just the picked day's list. */}
            {list && (
              <div className={cn('flex w-full flex-col', boxed ? 'mx-auto max-w-2xl overflow-hidden rounded-xl border bg-card' : 'gap-2')}>
                {boxed ? (
                  <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-foreground/80">
                    <span className={cn(at === today && 'font-semibold text-primary')}>
                      {format(dateOf(at), 'EEEE')}
                      {at === today && ' · today'}
                    </span>
                    {list.long.length + list.cards.length > 0 && (
                      <span className="ml-auto font-normal text-muted-foreground tabular-nums">
                        {list.long.length + list.cards.length} {list.long.length + list.cards.length === 1 ? 'card' : 'cards'}
                      </span>
                    )}
                  </div>
                ) : (
                  <h3 className={cn('mt-1 text-xs font-medium text-muted-foreground', at === today && 'font-semibold text-primary')}>
                    {format(dateOf(at), 'EEEE d MMMM')}
                  </h3>
                )}
                <div className={cn('flex flex-col gap-2', boxed && 'p-3 sm:p-4')}>
                  {list.long.length > 0 && <h3 className="mt-1 text-xs font-medium text-muted-foreground first:mt-0">Over several days</h3>}
                  {list.long.map((id) => (
                    <Row key={id} card={byId.get(id)!} draw={draw} boxed={boxed} />
                  ))}
                  {list.cards.some((c) => !c.time) && (
                    <h3 className="mt-1 text-xs font-medium text-muted-foreground first:mt-0">Any time that day</h3>
                  )}
                  {list.cards
                    .filter((c) => !c.time)
                    .map((c) => (
                      <Row key={c.id} card={c} draw={draw} boxed={boxed} />
                    ))}
                  {list.cards.some((c) => c.time) && <h3 className="mt-1 text-xs font-medium text-muted-foreground first:mt-0">At a time</h3>}
                  {list.cards
                    .filter((c) => c.time)
                    .map((c) => (
                      <Row key={c.id} card={c} draw={draw} boxed={boxed} />
                    ))}
                  {!list.long.length && !list.cards.length && <p className="py-2 text-sm text-muted-foreground">Nothing that day.</p>}
                  {!readOnly && (
                    <NewCard
                      key={at}
                      className="mt-1 h-10 text-sm"
                      placeholder="Add a card on this day: a title, and a time if you like"
                      onAdd={(text) => add(at, text)}
                    />
                  )}
                </div>
              </div>
            )}

            <div className={cn('flex flex-col gap-1', boxed && 'mx-auto w-full max-w-2xl')}>
              {hiddenSubtasks > 0 && (
                <p className="px-1 text-xs text-muted-foreground">
                  {hiddenSubtasks.toLocaleString()} {hiddenSubtasks === 1 ? 'subtask with a date isn’t' : 'subtasks with a date aren’t'} shown ·{' '}
                  <button onClick={() => set({ subtasks: true })} className="font-medium text-foreground/80 hover:text-foreground hover:underline">
                    Show
                  </button>
                </p>
              )}
              {undated > 0 && (
                <p className="px-1 text-xs text-muted-foreground">
                  {undated.toLocaleString()} {undated === 1 ? 'card has no date, so it isn’t' : 'cards have no date, so they aren’t'} on the calendar.
                  Bars and the Board show {undated === 1 ? 'it' : 'them'}.
                </p>
              )}
              <HiddenDoneNote count={hiddenDone} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/** What drawing a card needs from the board. */
interface Draw {
  idx: ReturnType<typeof useBoard>['idx']
  baseDepth: number
  readOnly: boolean
  memberName: (id: string | undefined) => string
  openTask: (id: string) => void
  /** A card was picked up, held by a day. */
  held: (e: DragEvent, id: string, day: number) => void
}

/** What a card says of itself wherever it is drawn: what it is under, and how many of its subtasks are done. */
function cardBits(id: string, draw: Draw) {
  const { idx, baseDepth } = draw
  const t = idx.tasks[id]
  const col = statusCol(idx, id)
  // (Under the task the view is focused on, its children are the top level: they say nothing of a parent.)
  const parent = t.parentId && idx.depth.get(id)! > baseDepth ? idx.tasks[t.parentId] : undefined
  const total = idx.subTotal.get(id) ?? 0
  return { t, col, done: col.category === 'done', parent, total, subDone: idx.subDone.get(id) ?? 0 }
}

const Kids = ({ done, total }: { done: number; total: number }) => (
  <span
    className="shrink-0 rounded-full border px-1.5 text-[10px] leading-4 text-muted-foreground tabular-nums"
    title={`${done} of its ${total} subtasks ${done === 1 ? 'is' : 'are'} done`}
  >
    {done}/{total}
  </span>
)

/** What sits at a card's right: its priority, how many of its subtasks are done, and (with room) who it is with. */
function Marks({ id, draw, who, className }: { id: string; draw: Draw; who?: boolean; className?: string }) {
  const { t, total, subDone } = cardBits(id, draw)
  const person = who && t.assigneeId ? draw.memberName(t.assigneeId) : ''
  if (!t.priority && !total && !person) return null
  return (
    <span className={cn('flex shrink-0 items-center gap-1', className)}>
      {t.priority && <PriorityIcon priority={t.priority} className="size-3.5" />}
      {total > 0 && <Kids done={subDone} total={total} />}
      {person && <Avatar name={person} picture={draw.idx.members.get(t.assigneeId!)?.picture} className="size-[18px] shrink-0 text-[9px]" />}
    </span>
  )
}

/** One week of the grid: seven days, with the cards that last several days as bars across the top. */
function Week({
  week,
  draw,
  byId,
  month,
  today,
  max,
  roomy,
  minHeight,
  over,
  adding,
  onOver,
  onDrop,
  onOpenDay,
  onAdding,
  onAdd,
}: {
  week: WeekRow
  draw: Draw
  byId: Map<string, DayCard>
  /** The month being shown (days of another are greyed), or null when it isn't a month. */
  month: number | null
  today: number
  max: number
  /** More air between the cards (a week or two, which have the height for it). */
  roomy: boolean
  minHeight: string
  over: number | null
  adding: number | null
  onOver: (day: number | null) => void
  onDrop: (e: DragEvent, day: number) => void
  onOpenDay: (day: number) => void
  onAdding: (day: number | null) => void
  onAdd: (day: number, text: string) => void
}) {
  // Room above each day's cards for its number and the bars (each bar with air under it, and a little more before
  // the day's own cards begin).
  const top = 34 + week.lanes * 28 + (week.lanes ? 4 : 0)
  return (
    <div className="relative grid grid-cols-7 border-b last:border-b-0" style={{ minHeight }}>
      {week.days.map((ids, i) => {
        const day = week.first + i
        const p = dayParts(day)
        const shown = max && ids.length > max ? ids.slice(0, max - 1) : ids
        return (
          <div
            key={day}
            data-day={fromDay(day)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG)) return
              e.preventDefault()
              if (over !== day) onOver(day)
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && over === day && onOver(null)}
            onDrop={(e) => onDrop(e, day)}
            className={cn(
              'group/day relative flex min-w-0 flex-col border-r px-1.5 pb-2 last:border-r-0',
              // (Cards are blocks with an edge: they need air between them. A month keeps them a little closer.)
              roomy ? 'gap-2' : 'gap-1.5',
              month !== null && p.month !== month && 'bg-muted/40',
              over === day && 'bg-primary/10',
            )}
            style={{ paddingTop: top }}
          >
            <button
              onClick={() => onOpenDay(day)}
              aria-label={`Open ${format(dateOf(day), 'EEEE d MMMM')}`}
              className={cn(
                'absolute top-1.5 right-1.5 grid h-[22px] min-w-[22px] place-items-center rounded-full px-1.5 text-xs font-medium text-foreground/85 tabular-nums hover:bg-accent hover:text-foreground',
                month !== null && p.month !== month && 'font-normal text-muted-foreground/70',
                day === today && 'bg-primary font-semibold text-primary-foreground hover:bg-primary hover:text-primary-foreground',
              )}
            >
              {p.date === 1 || (month === null && i === 0) ? format(dateOf(day), 'd MMM') : p.date}
            </button>
            {!draw.readOnly && (
              <button
                onClick={() => onAdding(day)}
                aria-label={`Add a card on ${format(dateOf(day), 'EEEE d MMMM')}`}
                title="Add a card on this day"
                className="absolute top-1.5 left-1.5 grid size-[22px] place-items-center rounded-md text-muted-foreground opacity-0 group-hover/day:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-60"
              >
                <Plus className="size-3.5" />
              </button>
            )}
            {shown.map((id) => (
              <Chip key={id} card={byId.get(id)!} draw={draw} />
            ))}
            {shown.length < ids.length && (
              <button
                onClick={() => onOpenDay(day)}
                className="ml-1.5 self-start rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                +{ids.length - shown.length} more
              </button>
            )}
            {adding === day && (
              <NewCard
                autoFocus
                className="h-7 text-xs"
                placeholder="Title, and a time if you like"
                onAdd={(text) => onAdd(day, text)}
                onClose={() => onAdding(null)}
              />
            )}
          </div>
        )
      })}
      <div className="pointer-events-none absolute inset-x-0 top-[34px] grid grid-cols-7 gap-y-1.5" style={{ gridAutoRows: '22px' }}>
        {week.bars.map((b) => (
          <Bar key={b.id} bar={b} first={week.first} draw={draw} />
        ))}
      </div>
    </div>
  )
}

/**
 * A card on its day, the same in a month, two weeks and a week (a day is as wide in each): its time, its title in
 * full, and at its right its priority, its subtasks and who it is with. The words run on under the time and the
 * marks, the whole width of the card, like a line of text that wraps; the row of days grows to fit.
 */
function Chip({ card, draw }: { card: DayCard; draw: Draw }) {
  const { t, col, done, parent } = cardBits(card.id, draw)
  return (
    <button
      draggable={!draw.readOnly}
      onDragStart={(e) => draw.held(e, card.id, card.start)}
      onClick={() => draw.openTask(card.id)}
      title={`${t.title}${parent ? ` · under ${parent.title}` : ''} · ${col.name}`}
      className="block w-full shrink-0 rounded-md border bg-background px-2 py-1.5 text-left text-xs leading-[1.4] break-words hover:border-primary/60"
    >
      <Marks id={card.id} draw={draw} who className="float-right ml-2 h-[1.4em]" />
      <StatusDot category={col.category} color={col.color} className="mr-1.5 mb-px size-[7px] align-middle" />
      {card.time && <span className="mr-1.5 font-medium text-muted-foreground tabular-nums">{card.time}</span>}
      <span className={cn(done && 'text-muted-foreground line-through')}>
        {parent && <span className="text-muted-foreground">{parent.title} › </span>}
        {t.title}
      </span>
    </button>
  )
}

/** A card that lasts several days, across the days it covers in one week. */
function Bar({ bar, first, draw }: { bar: WeekRow['bars'][number]; first: number; draw: Draw }) {
  const { t, col, parent } = cardBits(bar.id, draw)
  // (The same colours as the Timeline's bars: the card's own, or its list's.)
  const c = t.color ? tone(t.color) : statusTone(col.category, col.color)
  return (
    <button
      draggable={!draw.readOnly}
      onDragStart={(e) => {
        // Held by the day under the pointer, so it moves by as many days as it is dragged.
        const box = e.currentTarget.getBoundingClientRect()
        const days = bar.to - bar.from + 1
        const at = Math.min(days - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * days)))
        draw.held(e, bar.id, first + bar.from + at)
      }}
      onClick={() => draw.openTask(bar.id)}
      title={`${t.title} · ${col.name}`}
      className={cn(
        'pointer-events-auto mx-1.5 flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-xs font-medium',
        bar.before && 'ml-0 rounded-l-none border-l-0',
        bar.after && 'mr-0 rounded-r-none border-r-0',
      )}
      style={{
        gridColumn: `${bar.from + 1} / ${bar.to + 2}`,
        gridRow: bar.lane + 1,
        borderColor: c,
        backgroundColor: `color-mix(in oklab, ${c} 30%, var(--background))`,
      }}
    >
      <span className="min-w-0 flex-1 truncate">
        {parent && <span className="font-normal opacity-70">{parent.title} › </span>}
        {t.title}
      </span>
      <Marks id={bar.id} draw={draw} />
    </button>
  )
}

/** A card as a line of a day's list: its time, its title, its list, who it is with. */
function Row({ card, draw, boxed }: { card: DayCard; draw: Draw; boxed?: boolean }) {
  const { t, col, done, parent, total, subDone } = cardBits(card.id, draw)
  const long = card.start !== card.end
  return (
    <button
      onClick={() => draw.openTask(card.id)}
      className={cn(
        'flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm hover:border-primary/60',
        // (Inside the day's box, a card stands out against it.)
        boxed ? 'bg-background' : 'bg-card',
        long && 'border-transparent bg-primary/10',
      )}
    >
      {!long && <span className="w-11 shrink-0 font-medium tabular-nums">{card.time ?? '—'}</span>}
      <StatusDot category={col.category} color={col.color} />
      <span className={cn('min-w-0 flex-1 truncate', done && 'text-muted-foreground line-through')}>
        {parent && <span className="text-muted-foreground">{parent.title} › </span>}
        {t.title}
        {long && (
          <span className="ml-1.5 text-xs text-muted-foreground">
            {format(dateOf(card.start), 'd MMM')} to {format(dateOf(card.end), 'd MMM')}
          </span>
        )}
      </span>
      {t.priority && <PriorityIcon priority={t.priority} />}
      {total > 0 && <Kids done={subDone} total={total} />}
      <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">{col.name}</span>
      {t.assigneeId && (
        <Avatar
          name={draw.memberName(t.assigneeId)}
          picture={draw.idx.members.get(t.assigneeId)?.picture}
          className="size-[22px] shrink-0 text-[10px]"
        />
      )}
    </button>
  )
}

/** The box a new card's title is typed in: Enter adds it and waits for the next, Esc (or leaving it empty) closes. */
function NewCard({
  onAdd,
  onClose,
  placeholder,
  className,
  autoFocus,
}: {
  onAdd: (text: string) => void
  onClose?: () => void
  placeholder: string
  className?: string
  autoFocus?: boolean
}) {
  const [value, setValue] = useState('')
  return (
    <input
      autoFocus={autoFocus}
      value={value}
      maxLength={500}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) {
          onAdd(value)
          setValue('')
        } else if (e.key === 'Escape') {
          setValue('')
          onClose?.()
          // (Not the card's window or a menu behind it.)
          e.stopPropagation()
        }
      }}
      onBlur={() => !value.trim() && onClose?.()}
      className={cn(
        'w-full min-w-0 shrink-0 rounded-md border border-input bg-background px-2 outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
    />
  )
}
