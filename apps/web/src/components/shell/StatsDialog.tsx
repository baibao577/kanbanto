import { ArrowDown, ArrowUp, CalendarCheck, ChartBar, HourglassHigh, Kanban, Moon, Timer, type Icon } from '@phosphor-icons/react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useBoard } from '@/app/board-context'
import { StatusDot } from '@/components/common/bits'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fromDay } from '@kanbanto/model/dates'
import { boardStats, DONE_BUCKETS, STAT_PERIODS, type BoardStats, type StatCard } from '@kanbanto/model/stats'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A length of time in a few words: "40 min", "5 hours", "3.5 days", "6 weeks". */
function span(ms: number): string {
  const n = (v: number, unit: string) => `${v < 10 && v % 1 ? v.toFixed(1) : Math.round(v)} ${unit}${Math.round(v * 10) === 10 ? '' : 's'}`
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`
  if (ms < DAY) return n(ms / HOUR, 'hour')
  if (ms < 21 * DAY) return n(ms / DAY, 'day')
  if (ms < 90 * DAY) return n(ms / (7 * DAY), 'week')
  return n(ms / (30 * DAY), 'month')
}
const days = (d: number) =>
  d < 1 ? 'today' : d === 1 ? '1 day' : d < 60 ? `${d} days` : d < 730 ? `${Math.round(d / 30)} months` : `${Math.round(d / 365)} years`
const cards = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}`
const dayName = (day: number) => formatDay(fromDay(day), true)

/** The readout that follows the pointer over a chart's marks (also shown when a mark has the keyboard's focus). */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null)
  const on = (body: ReactNode) => ({
    onPointerEnter: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, body }),
    onPointerMove: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, body }),
    onPointerLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent) => {
      const r = e.currentTarget.getBoundingClientRect()
      setTip({ x: r.left + r.width / 2, y: r.top, body })
    },
    onBlur: () => setTip(null),
  })
  // Outside the dialog (which is moved into place with a transform), so `fixed` means the window.
  const node =
    tip &&
    createPortal(
      <div
        role="tooltip"
        className="pointer-events-none fixed z-[60] max-w-56 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
        style={{ left: Math.min(tip.x + 12, window.innerWidth - 236), top: Math.max(8, tip.y - 44) }}
      >
        {tip.body}
      </div>,
      document.body,
    )
  return { on, node }
}
type Tip = ReturnType<typeof useTip>['on']

/** A tooltip line: the number first, then what it is (keyed by a short stroke of its color). */
function TipRow({ color, value, label }: { color?: string; value: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {color && <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  )
}

/** Board stats: how the board is doing at a glance. Opened from the board's ⋯ menu. */
export function StatsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data, idx, counts, openTask } = useBoard()
  const [period, setPeriod] = useState<number>(30)
  const s = useMemo(
    () => (open ? boardStats(data, idx, { days: period, lastComment: counts.lastComment }) : null),
    [open, data, idx, period, counts.lastComment],
  )
  const tip = useTip()
  const show = (id: string) => {
    onOpenChange(false)
    openTask(id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* On a wide screen it takes most of the page, so everything shows at once. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl lg:max-w-[min(72rem,calc(100vw-4rem))]">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b px-5 pt-4 pr-12 pb-3">
          <div>
            <DialogTitle className="text-base">Board stats</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">Cards are tasks without subtasks. Archived ones count too.</DialogDescription>
          </div>
          {/* One range for everything below it that looks back in time. */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(period)}
            onValueChange={(v) => v && setPeriod(Number(v))}
            aria-label="Period"
          >
            {STAT_PERIODS.map((d) => (
              <ToggleGroupItem key={d} value={String(d)} className="px-2.5 text-xs">
                {d} days
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {/* Each thing it shows sits in its own card, on a slightly darker ground. */}
        {s && (
          <div className="grid gap-3 bg-background p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-12">
            <TimeToDone s={s} tip={tip.on} />
            <Figures s={s} />
            <Flow s={s} tip={tip.on} />
            <Heat s={s} tip={tip.on} />
            <Lists s={s} tip={tip.on} />
            <CardList
              icon={HourglassHigh}
              title="Open the longest"
              hint="since they were made"
              cards={s.oldest}
              onOpen={show}
              className="lg:col-span-6"
            />
            <CardList
              icon={Moon}
              title="Untouched the longest"
              hint="since anything happened"
              cards={s.untouched}
              onOpen={show}
              className="lg:col-span-6"
            />
          </div>
        )}
        {tip.node}
      </DialogContent>
    </Dialog>
  )
}

const CARD = 'rounded-xl border bg-card shadow-xs'

/** One card of the page: a title with its icon, and what it shows. */
function Section({
  icon: I,
  title,
  hint,
  children,
  className,
}: {
  icon: Icon
  title: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn(CARD, 'flex flex-col p-4', className)}>
      <h3 className="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold">
        <I className="size-4 text-muted-foreground" />
        {title}
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </h3>
      {children}
    </section>
  )
}

/** A number compared with the period before: an arrow and the difference in words. `lowerIsBetter`: for durations. */
function Versus({
  now,
  before,
  words,
  lowerIsBetter,
}: {
  now: number
  before: number | null
  words: (diff: number) => string
  lowerIsBetter?: boolean
}) {
  if (before === null || now === before) return null
  const up = now > before
  const good = lowerIsBetter ? !up : up
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon weight="bold" className={cn('size-3', good ? 'text-status-done' : 'text-warning')} />
      {words(Math.abs(now - before))}
    </span>
  )
}

/** The headline: how long cards take from made to done, and how they spread from quick to slow. */
function TimeToDone({ s, tip }: { s: BoardStats; tip: Tip }) {
  const most = Math.max(1, ...s.buckets)
  return (
    <Section icon={Timer} title="Time to done" hint={`cards done in the last ${s.days} days`} className="sm:col-span-2 lg:col-span-8">
      {/* (In a row with the figures, it's as tall as they are: the number and its chart sit in the middle.) */}
      <div className="my-auto grid items-end gap-x-8 gap-y-5 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          {s.timeToDone === null ? (
            <>
              <p className="text-5xl leading-none font-semibold text-muted-foreground">—</p>
              <p className="mt-2 text-sm text-muted-foreground">No cards were done in the last {s.days} days.</p>
            </>
          ) : (
            <>
              <p className="text-5xl leading-none font-semibold">{span(s.timeToDone)}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                is what a card usually takes from made to done <span className="whitespace-nowrap">(the middle of {cards(s.done)})</span>
              </p>
              <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                <Versus
                  now={s.timeToDone}
                  before={s.timeToDoneBefore}
                  lowerIsBetter
                  words={(d) => `${span(d)} ${s.timeToDone! < s.timeToDoneBefore! ? 'quicker' : 'slower'} than the ${s.days} days before`}
                />
                <span className="text-xs text-muted-foreground">
                  Quickest {span(s.quickest!)} · slowest {span(s.slowest!)}
                </span>
              </p>
            </>
          )}
        </div>

        {/* How they spread: one column per length of time, quick to slow. */}
        <div role="img" aria-label={`How long cards took: ${DONE_BUCKETS.map((b, i) => `${b.label} ${s.buckets[i]}`).join(', ')}`}>
          <div className="flex h-28 items-end border-b lg:h-32">
            {DONE_BUCKETS.map((b, i) => (
              <div
                key={b.label}
                tabIndex={0}
                className="group flex h-full flex-1 flex-col items-center justify-end outline-none"
                {...tip(<TipRow value={s.buckets[i]} label={`took ${b.label.toLowerCase()}`} />)}
              >
                <span className="mb-1 text-xs text-muted-foreground tabular-nums">{s.buckets[i] || ''}</span>
                <div
                  className="w-6 rounded-t bg-(--chart-made) transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80"
                  style={{ height: `${(s.buckets[i] / most) * 78}%`, minHeight: s.buckets[i] ? 3 : 0 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex">
            {DONE_BUCKETS.map((b) => (
              <span key={b.label} className="flex-1 text-center text-[11px] leading-tight text-muted-foreground">
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Section>
  )
}

/** Six numbers, a small card each: what came in and went out over the period, and how things stand now. */
function Figures({ s }: { s: BoardStats }) {
  return (
    <dl className="grid grid-cols-3 gap-3 sm:col-span-2 lg:col-span-4 lg:grid-cols-2">
      <Figure label="Made" value={s.created}>
        <Versus now={s.created} before={s.createdBefore} words={(d) => `${d} ${s.created > s.createdBefore ? 'more' : 'fewer'}`} />
      </Figure>
      <Figure label="Done" value={s.done}>
        <Versus now={s.done} before={s.doneBefore} words={(d) => `${d} ${s.done > s.doneBefore ? 'more' : 'fewer'}`} />
      </Figure>
      <Figure label="Open now" value={s.open} />
      <Figure label="In progress" value={s.inProgress} />
      <Figure label="Overdue" value={s.overdue} warn={s.overdue > 0} />
      <Figure label="Due in 7 days" value={s.dueSoon} />
    </dl>
  )
}

function Figure({ label, value, warn, children }: { label: string; value: number; warn?: boolean; children?: ReactNode }) {
  return (
    <div className={cn(CARD, 'flex flex-col justify-center px-4 py-2.5', warn && 'border-warning/40 bg-warning/5')}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
        <span className={cn('text-2xl leading-tight font-semibold', warn && 'text-warning')}>{value.toLocaleString()}</span>
        {children}
      </dd>
    </div>
  )
}

/** Cards made and cards done, side by side over the period: is the board growing or shrinking? */
function Flow({ s, tip }: { s: BoardStats; tip: Tip }) {
  const top = Math.max(1, ...s.flow.flatMap((f) => [f.created, f.done]))
  const weekly = s.flow.some((f) => f.to > f.from)
  // A label under some of the slots: every day of a week, else about five across.
  const every = s.flow.length <= 7 ? 1 : Math.ceil(s.flow.length / 5)
  const name = (f: BoardStats['flow'][number]) => (f.to > f.from ? `${formatDay(fromDay(f.from))} to ${formatDay(fromDay(f.to))}` : dayName(f.to))
  return (
    <Section icon={ChartBar} title="Made and done" hint={weekly ? 'each week' : 'each day'} className="lg:col-span-5">
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-(--chart-made)" /> Made
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-(--chart-done)" /> Done
        </span>
        <span className="ml-auto tabular-nums">
          peak {top} a {weekly ? 'week' : 'day'}
        </span>
      </div>
      <div
        className="mt-2 flex h-32 items-end border-b lg:h-36"
        role="img"
        aria-label={`Cards made and done ${weekly ? 'each week' : 'each day'} over the last ${s.days} days`}
      >
        {s.flow.map((f) => (
          <div
            key={f.to}
            tabIndex={0}
            className="flex h-full flex-1 items-end justify-center gap-0.5 rounded-t outline-none hover:bg-muted focus-visible:bg-muted"
            {...tip(
              <>
                <div className="mb-1 text-muted-foreground">{name(f)}</div>
                <TipRow color="var(--chart-made)" value={f.created} label="made" />
                <TipRow color="var(--chart-done)" value={f.done} label="done" />
              </>,
            )}
          >
            <div
              className="w-full max-w-2.5 rounded-t-[3px] bg-(--chart-made)"
              style={{ height: `${(f.created / top) * 100}%`, minHeight: f.created ? 2 : 0 }}
            />
            <div
              className="w-full max-w-2.5 rounded-t-[3px] bg-(--chart-done)"
              style={{ height: `${(f.done / top) * 100}%`, minHeight: f.done ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex">
        {s.flow.map((f, i) => (
          <span key={f.to} className="flex-1 overflow-visible text-center text-[11px] whitespace-nowrap text-muted-foreground">
            {(s.flow.length - 1 - i) % every === 0 ? (s.flow.length <= 7 ? dayName(f.to).slice(0, 3) : formatDay(fromDay(f.to))) : ''}
          </span>
        ))}
      </div>
      {/* The same numbers for screen readers. (In a box: a table itself can't be made 1px tall, and would add to the scrolling.) */}
      <div className="sr-only">
        <table>
          <caption>Cards made and done</caption>
          <tbody>
            {s.flow.map((f) => (
              <tr key={f.to}>
                <th>{name(f)}</th>
                <td>{f.created} made</td>
                <td>{f.done} done</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

/** Open cards per list, right now. */
function Lists({ s, tip }: { s: BoardStats; tip: Tip }) {
  const top = Math.max(1, ...s.lists.map((l) => l.count))
  return (
    <Section icon={Kanban} title="Where open cards sit" hint="right now" className="sm:col-span-2 lg:col-span-3">
      <ul className="mt-3 space-y-2.5">
        {s.lists.map(({ column, count }) => (
          <li
            key={column.id}
            tabIndex={0}
            className="group grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-3 text-sm outline-none"
            {...tip(<TipRow value={count} label={`open in ${column.name}`} />)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <StatusDot category={column.category} color={column.color} />
              <span className="truncate">{column.name}</span>
            </span>
            <span className="flex items-center gap-2">
              <span
                className="h-2.5 rounded-r bg-(--chart-made) transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80"
                style={{ width: `${(count / top) * 82}%`, minWidth: count ? 3 : 0 }}
              />
              <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Cards done on each day, a column per week: the darker, the more. */
function Heat({ s, tip }: { s: BoardStats; tip: Tip }) {
  const top = Math.max(1, ...s.heat.map((h) => h.count))
  // Four steps of one color over the empty cell's gray.
  const fill = (n: number) =>
    n ? `color-mix(in oklab, var(--chart-done) ${[35, 55, 78, 100][Math.min(3, Math.ceil((n / top) * 4) - 1)]}%, var(--muted))` : 'var(--muted)'
  const weeks: BoardStats['heat'][] = []
  for (let i = 0; i < s.heat.length; i += 7) weeks.push(s.heat.slice(i, i + 7))
  const total = s.heat.reduce((n, h) => n + h.count, 0)
  const month = (day: number) => formatDay(fromDay(day)).split(' ')[1]
  return (
    <Section icon={CalendarCheck} title="Done each day" hint={`last ${weeks.length} weeks`} className="lg:col-span-4">
      {/* One grid: the days of the week down the side, then a column per week (its month on top). The cells take the
          room there is, so it fits a phone too. */}
      <div
        role="img"
        aria-label={`${cards(total)} done in the last ${weeks.length} weeks`}
        className="mt-3 grid gap-[3px] text-[10px] text-muted-foreground"
        style={{
          gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1rem))`,
          gridTemplateRows: 'auto repeat(7, auto)',
          gridAutoFlow: 'column',
        }}
      >
        <span />
        {['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d, i) => (
          <span key={i} className="self-center pr-1 leading-none">
            {d}
          </span>
        ))}
        {weeks.map((w, i) => (
          <Fragment key={w[0].day}>
            <span className="h-4 overflow-visible whitespace-nowrap">
              {(i === 0 || month(w[0].day) !== month(weeks[i - 1][0].day)) && i < weeks.length - 1 ? month(w[0].day) : ''}
            </span>
            {[0, 1, 2, 3, 4, 5, 6].map((d) =>
              w[d] ? (
                <span
                  key={d}
                  className="aspect-square w-full rounded-[3px] hover:ring-2 hover:ring-foreground/30"
                  style={{ backgroundColor: fill(w[d].count) }}
                  {...tip(<TipRow value={w[d].count} label={`done on ${dayName(w[d].day)}`} />)}
                />
              ) : (
                <span key={d} />
              ),
            )}
          </Fragment>
        ))}
      </div>
      <p className="mt-2.5 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="mr-auto">{cards(total)} done</span>
        Fewer
        {[0, 1, 2, 3, 4].map((n) => (
          <span key={n} className="size-3 rounded-[3px]" style={{ backgroundColor: fill((n / 4) * top) }} />
        ))}
        More
      </p>
    </Section>
  )
}

/** A short list of open cards with a number of days each; a row opens the card. */
function CardList({
  icon,
  title,
  hint,
  cards: list,
  onOpen,
  className,
}: {
  icon: Icon
  title: string
  hint: string
  cards: StatCard[]
  onOpen: (id: string) => void
  className?: string
}) {
  return (
    <Section icon={icon} title={title} hint={hint} className={className}>
      {list.length ? (
        <ol className="mt-2 -mx-2">
          {list.map((c) => (
            <li key={c.id}>
              <button onClick={() => onOpen(c.id)} className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted">
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.list}</span>
                <span className="w-16 shrink-0 text-right text-xs font-medium tabular-nums">{days(c.days)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No open cards.</p>
      )}
    </Section>
  )
}
