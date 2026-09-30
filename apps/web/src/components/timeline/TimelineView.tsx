import { ArrowSquareOut, ArrowsInSimple, ArrowsOutSimple, CalendarX, CaretDown, CaretRight, Check, Plus } from '@phosphor-icons/react'
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useBoard } from '@/app/board-context'
import { StatusDot } from '@/components/common/bits'
import { Empty } from '@/components/common/Empty'
import { QuickAdd } from '@/components/board/QuickAdd'
import { FilterMenu } from '@/components/shell/FilterMenu'
import { PresetMenu } from '@/components/shell/PresetMenu'
import { BarIconButton, ViewActions } from '@/components/shell/ViewBar'
import { AddSubtaskRow, DropLine } from '@/components/tree/rows'
import { useRowDrag } from '@/components/tree/useRowDrag'
import { HiddenDoneNote, HideDoneToggle } from '@/components/tree/HiddenDone'
import { useTreeFilter } from '@/components/tree/useTreeFilter'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { dayParts, fromDay, shiftDays, taskSpan, todayDay } from '@kanbanto/model/dates'
import { formatDay } from '@/lib/format'
import { statusCol } from '@kanbanto/model/indexer'
import { afterSubtree, defaultExpanded, flattenTree, treeTop } from '@kanbanto/model/tree'
import { COLORS, statusTone, tone, type ColorName } from '@kanbanto/model/colors'

type Zoom = 'day' | 'week' | 'month'
const DAY_W: Record<Zoom, number> = { day: 36, week: 14, month: 4 }
/** Shortest timeline per zoom, so it always fills a wide screen. */
const MIN_DAYS: Record<Zoom, number> = { day: 60, week: 150, month: 450 }
const ROW_H = 36
const LEFT_W = 280
const ROWS_STEP = 500
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type DragMode = 'move' | 'start' | 'end'
interface Drag {
  id: string
  mode: DragMode
  x0: number
  start: number
  end: number
  delta: number
}

/** Applies a drag of `delta` days. Resizing never lets start pass end. */
function dragged(d: Drag) {
  if (d.mode === 'move') return { start: d.start + d.delta, end: d.end + d.delta }
  if (d.mode === 'start') return { start: Math.min(d.start + d.delta, d.end), end: d.end }
  return { start: d.start, end: Math.max(d.end + d.delta, d.start) }
}

/**
 * Nested task list on the left, one independent bar per task on the right.
 * Drag a bar to move it, drag its ends to change the dates, click an empty row to schedule.
 */
export function TimelineView({ search }: { search: string }) {
  const { data, prefs, idx, run, openTask, createTask, readOnly } = useBoard()
  const [expanded, setExpanded] = useState(() => defaultExpanded(idx))
  const [limit, setLimit] = useState(ROWS_STEP)
  const [zoom, setZoom] = useState<Zoom>('day')
  const [drag, setDrag] = useState<Drag | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const dayW = DAY_W[zoom]
  const today = todayDay()
  const focusId = prefs.focusId && prefs.focusId in data.tasks ? prefs.focusId : undefined
  const { top, baseDepth } = treeTop(idx, focusId)
  // Search and filters (shared with every tab) keep the matches plus their parents, muted, for context.
  const { keep, matched, filtering, hiddenDone } = useTreeFilter(search)
  const { rows, truncated } = useMemo(() => flattenTree(idx, top, expanded, limit, keep), [idx, top, expanded, limit, keep])

  const expand = (id: string) => {
    if (!expanded.has(id)) setExpanded(new Set(expanded).add(id))
  }
  // Reorder / move rows by dragging the task name on the left (dragging a bar changes its dates instead).
  const { dragId, zoneOf, dragProps, dropProps } = useRowDrag(expand)
  // Inline "add a subtask": the field sits under the parent's last visible subtask and pushes rows below it down.
  const [adding, setAdding] = useState<string | null>(null)
  const addAfter = adding ? afterSubtree(idx, rows, adding) : -1
  const rowY = (i: number) => (i + (addAfter >= 0 && i > addAfter ? 1 : 0)) * ROW_H
  const bodyHeight = (rows.length + (addAfter >= 0 ? 1 : 0)) * ROW_H
  const spans = useMemo(() => new Map(rows.map((id) => [id, taskSpan(idx.tasks[id])])), [rows, idx])

  // Date range: every bar on screen plus today, padded. Built from saved dates, so it holds still during a drag.
  const [rangeStart, rangeEnd] = useMemo(() => {
    let lo = today
    let hi = today
    for (const s of spans.values()) {
      if (!s) continue
      lo = Math.min(lo, s.start)
      hi = Math.max(hi, s.end)
    }
    const pad = zoom === 'day' ? 14 : zoom === 'week' ? 35 : 90
    return [lo - pad, Math.max(hi + pad, lo - pad + MIN_DAYS[zoom])]
  }, [spans, zoom, today])
  const width = (rangeEnd - rangeStart + 1) * dayW
  const x = (day: number) => (day - rangeStart) * dayW

  // Where "Today" scrolls to: today's column a third of the way across the visible timeline.
  const todayLeft = () => {
    const visible = (scroller.current?.clientWidth ?? 1200) - LEFT_W
    return Math.max(0, x(today) + dayW / 2 - visible / 3)
  }

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = todayLeft()
    // Only on open and zoom change; re-scrolling after every edit would yank the view away mid-work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  // ---- dragging a bar ----
  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    const span = spans.get(id)
    if (!span || e.button !== 0) return
    if (readOnly) return void openTask(id)
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const mode = ((e.target as HTMLElement).dataset.handle as DragMode | undefined) ?? 'move'
    setDrag({ id, mode, x0: e.clientX, start: span.start, end: span.end, delta: 0 })
  }
  const onBarMove = (e: ReactPointerEvent) => {
    if (!drag) return
    const delta = Math.round((e.clientX - drag.x0) / dayW)
    if (delta !== drag.delta) setDrag({ ...drag, delta })
  }
  const onBarUp = () => {
    if (!drag) return
    setDrag(null)
    if (drag.delta === 0) return drag.mode === 'move' ? openTask(drag.id) : undefined
    // Moved by whole days; a date with a time keeps its time.
    const s = dragged(drag)
    const t = data.tasks[drag.id]
    const start = t.start ? shiftDays(t.start, s.start - drag.start) : fromDay(s.start)
    const due = t.due ? shiftDays(t.due, s.end - drag.end) : fromDay(s.end)
    run({ type: 'task.update', id: drag.id, fields: { start, due } })
  }
  const spanOf = (id: string) => (drag?.id === id ? dragged(drag) : spans.get(id))

  // ---- header ----
  const { months, minor } = useMemo(() => {
    const months: { day: number; label: string }[] = []
    const minor: { day: number; label: string; weekend?: boolean }[] = []
    for (let d = rangeStart; d <= rangeEnd; d++) {
      const p = dayParts(d)
      if (p.date === 1 || d === rangeStart) months.push({ day: d, label: `${MONTHS[p.month]} ${p.year}` })
      if (zoom === 'day') minor.push({ day: d, label: String(p.date), weekend: p.weekday === 0 || p.weekday === 6 })
      else if (zoom === 'week' && p.weekday === 1) minor.push({ day: d, label: `${p.date} ${MONTHS[p.month]}` })
    }
    // The partial month at the start gets no label if the next one would overlap it.
    if (months.length > 1 && (months[1].day - months[0].day) * DAY_W[zoom] < 90) months.shift()
    return { months, minor }
  }, [rangeStart, rangeEnd, zoom])

  // Grid lines every day (day zoom) or every Monday. Day 4 after the epoch was a Monday.
  const gridStep = zoom === 'day' ? dayW : 7 * dayW
  const gridOffset = zoom === 'day' ? 0 : ((((4 - rangeStart) % 7) + 7) % 7) * dayW
  const trackStyle = {
    width,
    backgroundImage: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px)',
    backgroundSize: `${gridStep}px 100%`,
    backgroundPosition: `${gridOffset}px 0`,
  }

  // ---- "waiting on" arrows between visible, scheduled rows ----
  const rowOf = new Map(rows.map((id, i) => [id, i]))
  const arrows: { key: string; d: string; late: boolean }[] = []
  for (const id of rows) {
    const to = spanOf(id)
    if (!to) continue
    for (const b of idx.tasks[id].blockedBy) {
      const from = rowOf.has(b) ? spanOf(b) : null
      if (!from) continue
      const x1 = x(from.end + 1)
      const y1 = rowY(rowOf.get(b)!) + ROW_H / 2
      const x2 = x(to.start)
      const y2 = rowY(rowOf.get(id)!) + ROW_H / 2
      arrows.push({ key: `${b}>${id}`, late: from.end >= to.start, d: `M${x1},${y1} H${x1 + 8} V${y2} H${x2}` })
    }
  }

  return (
    <>
      <ViewActions>
        <PresetMenu />
        <FilterMenu />
        <HideDoneToggle />
        <ToggleGroup type="single" size="sm" variant="outline" value={zoom} onValueChange={(v) => v && setZoom(v as Zoom)}>
          <ToggleGroupItem value="day" className="px-3">
            Days
          </ToggleGroupItem>
          <ToggleGroupItem value="week" className="px-3">
            Weeks
          </ToggleGroupItem>
          <ToggleGroupItem value="month" className="px-3">
            Months
          </ToggleGroupItem>
        </ToggleGroup>
        <Button variant="outline" size="sm" className="h-8" onClick={() => scroller.current?.scrollTo({ left: todayLeft(), behavior: 'smooth' })}>
          Today
        </Button>
      </ViewActions>
      <ViewActions lead>
        <BarIconButton label="Expand all" onClick={() => setExpanded(new Set(idx.childrenOf.keys()))}>
          <ArrowsOutSimple />
        </BarIconButton>
        <BarIconButton label="Collapse all" onClick={() => setExpanded(new Set())}>
          <ArrowsInSimple />
        </BarIconButton>
      </ViewActions>

      {rows.length === 0 ? (
        <Empty action={hiddenDone ? <HiddenDoneNote count={hiddenDone} /> : undefined}>
          {search || filtering ? 'No tasks match.' : hiddenDone ? 'Everything here is done.' : 'No tasks here yet.'}
        </Empty>
      ) : (
        <div ref={scroller} className="h-full overflow-auto">
          <div className="relative" style={{ width: LEFT_W + width }}>
            {/* header */}
            <div className="sticky top-0 z-20 flex border-b bg-background">
              <div
                className="sticky left-0 z-30 flex shrink-0 items-end border-r bg-background px-4 pb-2 text-xs font-medium text-muted-foreground"
                style={{ width: LEFT_W }}
              >
                Task
              </div>
              <div className="relative h-12 shrink-0" style={{ width }}>
                {months.map((m) => (
                  <span key={m.day} className="absolute top-1.5 border-l pl-2 text-xs font-semibold whitespace-nowrap" style={{ left: x(m.day) }}>
                    {m.label}
                  </span>
                ))}
                {minor.map((m) => (
                  <span
                    key={m.day}
                    className={cn(
                      'absolute top-7 text-[11px] whitespace-nowrap text-muted-foreground',
                      zoom === 'day' ? 'text-center' : 'border-l border-grid-line pl-1.5',
                      m.weekend && 'text-muted-foreground/50',
                      m.day === today && 'font-bold text-primary',
                    )}
                    style={{ left: x(m.day), width: zoom === 'day' ? dayW : undefined }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
            </div>

            {/* rows */}
            <div className="relative">
              {rows.map((id, i) => {
                const t = idx.tasks[id]
                const kids = idx.childrenOf.get(id)
                const span = spanOf(id)
                const col = statusCol(idx, id)
                const open = !!keep || expanded.has(id)
                const w = span ? (span.end - span.start + 1) * dayW : 0
                const depth = idx.depth.get(id)! - baseDepth
                const zone = zoneOf(id)
                const context = matched && !matched.has(id) // shown only because a subtask matches
                const row = (
                  <div
                    key={id}
                    {...dropProps(id)}
                    className={cn('group relative flex border-b border-grid-line', dragId === id && 'opacity-40')}
                    style={{ height: ROW_H }}
                  >
                    <div
                      {...dragProps(id)}
                      title="Drag to move"
                      className={cn(
                        'drag-handle sticky left-0 z-10 flex shrink-0 cursor-grab items-center gap-1.5 overflow-hidden border-r bg-background pr-1.5 group-hover:bg-muted active:cursor-grabbing',
                        zone === 'inside' && 'bg-[color-mix(in_oklab,var(--primary)_10%,var(--background))] ring-2 ring-primary/40 ring-inset',
                      )}
                      style={{ width: LEFT_W, paddingLeft: depth * 16 + 8 }}
                    >
                      <button
                        disabled={!kids || !!keep}
                        onClick={() => toggle(id)}
                        aria-label={open ? 'Collapse' : 'Expand'}
                        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
                      >
                        {kids ? open ? <CaretDown className="size-3" /> : <CaretRight className="size-3" /> : null}
                      </button>
                      <StatusDot category={col.category} color={col.color} />
                      <button
                        onClick={() => openTask(id)}
                        className={cn(
                          'min-w-0 truncate text-left text-[13px] hover:underline',
                          kids && 'font-medium',
                          context && 'font-normal text-muted-foreground',
                        )}
                      >
                        {t.title}
                      </button>
                      <button
                        hidden={readOnly}
                        onClick={() => {
                          expand(id)
                          setAdding(id)
                        }}
                        aria-label="Add a subtask"
                        title="Add a subtask"
                        className="ml-auto grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                    <div
                      className={cn('relative shrink-0 group-hover:bg-muted/40', !span && !readOnly && 'cursor-copy')}
                      style={trackStyle}
                      title={span || readOnly ? undefined : 'Click to schedule'}
                      onClick={
                        span || readOnly
                          ? undefined
                          : (e) => {
                              const day = rangeStart + Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / dayW)
                              run({ type: 'task.update', id, fields: { start: fromDay(day), due: fromDay(day + 2) } })
                            }
                      }
                    >
                      {span && (
                        <BarMenu
                          color={t.color}
                          onOpen={() => openTask(id)}
                          onColor={(color) => run({ type: 'task.update', id, fields: { color: color ?? null } })}
                          onClearDates={() => run({ type: 'task.update', id, fields: { start: '', due: '' } })}
                        >
                          <div
                            data-bar-id={id}
                            className={cn(
                              'absolute top-1.5 bottom-1.5 z-[2] flex min-w-1.5 touch-none items-center rounded-md border select-none',
                              kids && 'border-2',
                              col.category === 'backlog' && !t.color && 'border-dashed',
                              drag?.id === id ? 'z-[3] cursor-grabbing shadow-lg' : 'cursor-grab',
                            )}
                            style={barStyle(t.color ? tone(t.color) : statusTone(col.category, col.color), { left: x(span.start), width: w })}
                            title={`${t.title}\n${formatDay(t.start ?? fromDay(span.start), true)} → ${formatDay(t.due ?? fromDay(span.end), true)} (${span.end - span.start + 1} ${span.end === span.start ? 'day' : 'days'})`}
                            onPointerDown={(e) => onBarDown(e, id)}
                            onPointerMove={onBarMove}
                            onPointerUp={onBarUp}
                            onPointerCancel={() => setDrag(null)}
                          >
                            <span data-handle="start" className="w-2 shrink-0 self-stretch cursor-ew-resize rounded-l-md hover:bg-foreground/15" />
                            {w >= 70 ? (
                              // Sticks to the visible edge when the bar starts off-screen.
                              <span
                                className={cn('pointer-events-none sticky min-w-0 truncate px-1 text-xs', kids && 'font-semibold')}
                                style={{ left: LEFT_W + 6 }}
                              >
                                {t.title}
                              </span>
                            ) : (
                              <span className="pointer-events-none absolute left-full ml-1.5 text-xs whitespace-nowrap">{t.title}</span>
                            )}
                            <span
                              data-handle="end"
                              className="ml-auto w-2 shrink-0 self-stretch cursor-ew-resize rounded-r-md hover:bg-foreground/15"
                            />
                          </div>
                        </BarMenu>
                      )}
                    </div>
                    <DropLine zone={zone} left={depth * 16 + 8} />
                  </div>
                )
                if (addAfter !== i || !adding) return row
                return [
                  row,
                  <AddSubtaskRow
                    key="__add"
                    className="border-grid-line"
                    style={{ height: ROW_H, width: LEFT_W + width }}
                    cellWidth={LEFT_W + 240}
                    indent={(idx.depth.get(adding)! - baseDepth + 1) * 16 + 8}
                    parentTitle={idx.tasks[adding].title}
                    onAdd={(title, fields) => createTask(adding, { ...fields, title })}
                    onClose={() => setAdding(null)}
                  />,
                ]
              })}

              <svg className="pointer-events-none absolute top-0 z-[2] overflow-visible" style={{ left: LEFT_W }} width={width} height={bodyHeight}>
                <defs>
                  {(['ok', 'late'] as const).map((k) => (
                    <marker key={k} id={`tl-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill={k === 'late' ? 'var(--destructive)' : 'var(--muted-foreground)'} />
                    </marker>
                  ))}
                </defs>
                <line
                  x1={x(today) + dayW / 2}
                  x2={x(today) + dayW / 2}
                  y1={0}
                  y2={bodyHeight}
                  stroke="var(--primary)"
                  strokeWidth={2}
                  opacity={0.5}
                />
                {arrows.map((a) => (
                  <path
                    key={a.key}
                    d={a.d}
                    fill="none"
                    stroke={a.late ? 'var(--destructive)' : 'var(--muted-foreground)'}
                    strokeWidth={1.5}
                    strokeDasharray={a.late ? '4 3' : undefined}
                    markerEnd={`url(#tl-arrow-${a.late ? 'late' : 'ok'})`}
                  />
                ))}
              </svg>
            </div>
          </div>
          {truncated && (
            <Button variant="ghost" size="sm" className="sticky left-0 m-3 text-muted-foreground" onClick={() => setLimit(limit + ROWS_STEP)}>
              Show more rows
            </Button>
          )}
          <HiddenDoneNote count={hiddenDone} className="sticky left-0 mx-3 mt-3" />
          {!search && (
            <div className="sticky left-0 w-72 p-2">
              <QuickAdd
                single
                label={focusId ? 'Add a subtask' : 'Add a project'}
                placeholder="Title"
                submitLabel="Add"
                dates
                onAdd={(title, fields) => createTask(focusId ?? null, { ...fields, title })}
              />
            </div>
          )}
        </div>
      )}
    </>
  )
}

const barStyle = (c: string, pos: React.CSSProperties): React.CSSProperties => ({
  ...pos,
  borderColor: c,
  backgroundColor: `color-mix(in oklab, ${c} 30%, var(--background))`,
})

/** Right-click a bar: open the task, pick its color, or take it off the timeline. */
function BarMenu({
  color,
  onOpen,
  onColor,
  onClearDates,
  children,
}: {
  color?: ColorName
  onOpen: () => void
  onColor: (c: ColorName | undefined) => void
  onClearDates: () => void
  children: React.ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onOpen}>
          <ArrowSquareOut /> Open task
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <span className="size-3.5 rounded-sm" style={{ backgroundColor: color ? tone(color) : 'var(--muted-foreground)' }} />
            Bar color
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuItem onSelect={() => onColor(undefined)}>
              <span className="size-3.5 rounded-sm shadow-[inset_0_0_0_1.5px_var(--border)]" />
              Same as its status
              {!color && <Check className="ml-auto" />}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {COLORS.map((c) => (
              <ContextMenuItem key={c.id} onSelect={() => onColor(c.id)}>
                <span className="size-3.5 rounded-sm" style={{ backgroundColor: tone(c.id) }} />
                {c.name}
                {color === c.id && <Check className="ml-auto" />}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClearDates}>
          <CalendarX /> Remove from timeline
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
