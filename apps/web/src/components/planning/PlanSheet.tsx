import { CaretDown, CaretRight, DotsSixVertical, Kanban, Scissors, X } from '@phosphor-icons/react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { PlanningView } from '@kanbanto/model/api'
import { tone } from '@kanbanto/model/colors'
import { dayParts, fromDay, mondayOf, monthEndOf, toDay } from '@kanbanto/model/dates'
import { newId } from '@kanbanto/model/ids'
import { formatDuration } from '@kanbanto/model/time'
import {
  canSplit,
  freeRangeAt,
  isWorkDay,
  loadOn,
  manDays,
  overlapsOnLine,
  personBlocks,
  personFacts,
  projectFacts,
  spanOf,
  type AddSize,
  type PlanBlock,
  type PlanData,
} from '@kanbanto/model/planning'
import type { PlanCommand } from '@kanbanto/model/planningCommands'
import { hrefFor } from '@/app/router'
import { Avatar } from '@/components/common/bits'
import { edgeSpeed } from '@/lib/pointerDrag'
import { formatAgo, formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AddPersonPicker, AddProjectPicker } from './pickers'
import { dayWidth, fmtMd, REACH, ROW_HEIGHT, sheetRange, ticks, type SheetRow, type Zoom } from './planLayout'

export interface SheetActions {
  /** Runs a command; shows why if it's refused. `done`: a message with Undo, for changes easy to miss. */
  run: (cmd: PlanCommand, done?: string) => boolean
  setBusy: (busy: boolean) => void
  openBlockMenu: (blockId: string, day: number | null, at: { x: number; y: number }) => void
  editProject: (id: string) => void
  editPerson: (id: string) => void
  newPerson: (projectId: string) => void
  toggleFinished: () => void
  /** Folds or unfolds a project's or person's group (`project:<id>`, `person:<id>`). */
  toggleGroup: (key: string) => void
}

interface Props extends SheetActions {
  plan: PlanData
  rows: SheetRow[]
  zoom: Zoom
  narrow: boolean
  today: number
  canEdit: boolean
  /** A touch screen: blocks aren't dragged (a tap opens their menu; fingers scroll). */
  coarse: boolean
  activity: PlanningView['activity']
  boards: PlanningView['boards']
  /** Scroll to today (when this number changes). */
  todayRequest: number
}

const HEADER_H = 48
const dayDate = (d: number) => formatDay(fromDay(d))
const monthName = (d: number) => {
  const p = dayParts(d)
  return new Date(Date.UTC(p.year, p.month, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}
const range = (s: number, e: number) => `${dayDate(s)} – ${dayDate(e)}`

/** The readout that follows the pointer while dragging (its own little store, so the sheet doesn't redraw). */
const tipStore = (() => {
  let value: { x: number; y: number; lines: ReactNode[]; bad: boolean } | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(v: typeof value) {
      value = v
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
})()

function DragTip() {
  const tip = useSyncExternalStore(tipStore.subscribe, tipStore.get)
  if (!tip) return null
  const left = Math.min(tip.x + 14, window.innerWidth - 300)
  const top = tip.y + 18 + 90 > window.innerHeight ? tip.y - 100 : tip.y + 18
  return (
    <div
      className={cn(
        'pointer-events-none fixed z-50 max-w-72 rounded-md px-2.5 py-1.5 text-xs leading-relaxed shadow-lg',
        tip.bad ? 'bg-destructive text-white' : 'bg-foreground text-background',
      )}
      style={{ left, top }}
      role="status"
    >
      {tip.lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

interface Drag {
  id: string
  el: HTMLElement
  home: HTMLElement | null
  mode: 'move' | 'start' | 'end'
  x0: number
  y0: number
  scroll0: { left: number; top: number }
  s: number
  e: number
  delta: number
  moved: boolean
  target: HTMLElement | null
  blocked: boolean
  last: { x: number; y: number }
  style: { left: string; width: string; transform: string }
}

/** Rearranging: a project or person's group dragged by its grip, up or down among the others of its kind. */
interface Reorder {
  kind: 'project' | 'person'
  id: string
  name: string
  section: string
  row: HTMLElement | null
  last: { x: number; y: number }
  /** Where it would go: before this one (undefined: last), or null when it wouldn't move. */
  before: string | undefined | null
}

/** A group on the sheet: a project or person's header row with the rows under it, and where it sits. */
interface Group {
  kind: 'project' | 'person'
  id: string
  name: string
  /** Groups only move among their own: running, prospect or finished projects; people. */
  section: string
  top: number
  bottom: number
}

/**
 * The plan on a timeline: a sticky header of months and weeks (or days), a sticky column of names and sums, and the
 * rows. Planners point at free space on a line to see where a week would go and click to add it; drag a block to move
 * it (onto another line to give it to someone else or another project), drag its ends to stretch it, point at it for
 * the scissors that split it, and click or right-click it for its menu. Hovering, dragging and the readout are drawn
 * outside React's renders, so the sheet stays smooth with many rows.
 */
export function PlanSheet(props: Props) {
  const { plan, rows, zoom, narrow, today, canEdit, coarse, run, setBusy, openBlockMenu } = props
  const dayW = dayWidth(zoom, narrow)
  const left = narrow ? 176 : 288
  // The sheet grows by a quarter when you scroll near either end (up to three years from today).
  // A quarter of room before, to start with, so there's always somewhere to scroll back to.
  const [more, setMore] = useState({ before: 13, after: 0 })
  const { start, end } = useMemo(() => sheetRange(plan, today, more), [plan, today, more])
  const prevStart = useRef(start)
  useLayoutEffect(() => {
    // Grown at the start: keep what you were looking at in place.
    if (start < prevStart.current && scroller.current) scroller.current.scrollBy((prevStart.current - start) * dayWidth(zoom, narrow), 0)
    prevStart.current = start
  }, [start, zoom, narrow])
  // Not as wide as the screen yet (months are narrow): grow until it is, so there's always somewhere to scroll.
  useEffect(() => {
    const s = scroller.current
    if (s && s.scrollWidth - s.clientWidth < 120 && end < today + REACH) setMore((m) => ({ ...m, after: m.after + 13 }))
  }, [end, dayW, today])
  const onScroll = () => {
    const s = scroller.current
    if (!s || drag.current) return
    if (s.scrollLeft < 120 && start > today - REACH) setMore((m) => ({ ...m, before: m.before + 13 }))
    else if (s.scrollLeft + s.clientWidth > s.scrollWidth - 120 && end < today + REACH) setMore((m) => ({ ...m, after: m.after + 13 }))
  }
  const width = (end - start + 1) * dayW
  const x = useCallback((d: number) => (d - start) * dayW, [start, dayW])
  const { months, minor } = useMemo(() => ticks(start, end, zoom, today, Math.ceil(80 / dayW)), [start, end, zoom, today, dayW])
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const mark = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const afterDrag = useRef(false)
  const frame = useRef(0)
  const [flash, setFlash] = useState<string | null>(null)

  // Today a third of the way in, when the sheet opens, the zoom changes, or Today is pressed.
  const toToday = useCallback(
    (smooth = false) => {
      const s = scroller.current
      if (s) s.scrollTo({ left: Math.max(0, x(today) - (s.clientWidth - left) / 3), behavior: smooth ? 'smooth' : 'auto' })
    },
    [x, today, left],
  )
  useEffect(() => toToday(), [zoom]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (props.todayRequest) toToday(true)
  }, [props.todayRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(t)
  }, [flash])

  const block = (id: string) => plan.blocks.find((b) => b.id === id)
  const dayAt = (clientX: number, track: Element) => start + Math.floor((clientX - track.getBoundingClientRect().left) / dayW)
  /** What a click on free space adds: a week, five working days (days) or a month. */
  const addSize: AddSize = zoom === 'days' ? 'days' : zoom === 'months' ? 'month' : 'week'
  /** Where a block would be split at the pointer: the nearest Monday (weeks, months) or day boundary (days). */
  const splitDayAt = (b: PlanBlock, clientX: number, track: Element) => {
    let d = start + Math.round((clientX - track.getBoundingClientRect().left) / dayW)
    if (zoom !== 'days') d = mondayOf(d + 3)
    return canSplit(b, d) ? d : null
  }
  const lineOf = (el: Element | null) => (el?.closest('[data-line]') as HTMLElement | null) ?? null
  const lineTarget = (el: HTMLElement) => ({
    projectId: el.dataset.project!,
    personId: el.dataset.person || null,
    slot: Number(el.dataset.slot ?? 0),
  })
  const relTop = (el: Element) => el.getBoundingClientRect().top - content.current!.getBoundingClientRect().top

  // ── Hover: the faint block on free space, and the scissors on a block ──────
  const hideHover = () => {
    if (ghost.current) ghost.current.hidden = true
    if (mark.current) mark.current.hidden = true
  }
  const hover = (e: React.PointerEvent) => {
    if (!canEdit || coarse || e.pointerType !== 'mouse' || !content.current) return
    const t = e.target as HTMLElement
    if (t.closest('[data-split]')) return
    const bar = t.closest('[data-block]') as HTMLElement | null
    // On the way from a block up to its scissors (they sit above it, often to one side): they stay where they are.
    const shown = mark.current!
    if (!shown.hidden && bar?.dataset.block !== shown.dataset.block) {
      const r = shown.getBoundingClientRect()
      const from = Number(shown.dataset.x)
      const onTheWay =
        e.clientY <= r.top + 1 && e.clientY >= r.top - 24 && e.clientX >= Math.min(from, r.left) - 12 && e.clientX <= Math.max(from, r.left) + 12
      if (onTheWay) return void (ghost.current!.hidden = true)
    }
    if (bar) {
      ghost.current!.hidden = true
      const b = block(bar.dataset.block!)
      const track = lineOf(bar)
      const d = b && track && !t.closest('[data-handle]') ? splitDayAt(b, e.clientX, track) : null
      if (d === null) return void (mark.current!.hidden = true)
      const m = mark.current!
      m.hidden = false
      m.style.left = `${left + x(d) - 1}px`
      m.style.top = `${relTop(bar)}px`
      m.style.height = `${bar.offsetHeight}px`
      m.dataset.block = b!.id
      m.dataset.day = String(d)
      m.dataset.x = String(e.clientX)
      m.querySelector('button')!.title = `Split on ${dayDate(d)}`
      return
    }
    mark.current!.hidden = true
    const track = lineOf(t)
    if (!track) return void (ghost.current!.hidden = true)
    const r = freeRangeAt(
      plan,
      track.dataset.project!,
      track.dataset.person || null,
      Math.max(start, dayAt(e.clientX, track)),
      addSize,
      Number(track.dataset.slot ?? 0),
    )
    if (!r) return void (ghost.current!.hidden = true)
    const g = ghost.current!
    g.hidden = false
    g.style.left = `${left + x(r.start)}px`
    g.style.width = `${x(r.end + 1) - x(r.start)}px`
    g.style.top = `${relTop(track) + 6}px`
    g.style.height = `${track.offsetHeight - 12}px`
  }

  // ── Dragging a block ────────────────────────────────────────────────────────
  const spanFor = (d: Drag) => {
    if (d.mode === 'move') return { s: d.s + d.delta, e: d.e + d.delta }
    if (d.mode === 'start') return { s: Math.min(d.s + d.delta, d.e), e: d.e }
    return { s: d.s, e: Math.max(d.e + d.delta, d.s) }
  }

  const follow = () => {
    const d = drag.current
    const s = scroller.current
    if (!d || !s) return
    const dx = d.last.x - d.x0 + (s.scrollLeft - d.scroll0.left)
    const dy = d.last.y - d.y0 + (s.scrollTop - d.scroll0.top)
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return
    if (!d.moved) {
      d.moved = true
      hideHover()
      d.el.classList.add('z-20', 'shadow-lg', 'cursor-grabbing')
    }
    d.delta = Math.round(dx / dayW)
    const r = spanFor(d)
    d.el.style.left = `${x(Math.max(r.s, start))}px`
    d.el.style.width = `${Math.max(dayW, x(Math.min(r.e, end) + 1) - x(Math.max(r.s, start)))}px`
    let target: HTMLElement | null = null
    if (d.mode === 'move') {
      d.el.style.transform = `translateY(${dy}px)`
      const over = document.elementsFromPoint(d.last.x, d.last.y).find((n) => n instanceof HTMLElement && n.dataset.line !== undefined) as
        HTMLElement | undefined
      target = over && over !== d.home ? over : null
    }
    if (target !== d.target) {
      d.target?.closest('[data-row]')?.classList.remove('bg-primary/8')
      target?.closest('[data-row]')?.classList.add('bg-primary/8')
      d.target = target
    }
    // The readout: new dates and man-days, the project against its plan, and the person's load.
    const b = block(d.id)!
    const to = d.target ? lineTarget(d.target) : { projectId: b.projectId, personId: b.personId, slot: b.slot }
    const moved: PlanBlock = { ...b, ...to, start: fromDay(r.s), end: fromDay(r.e) }
    const next = { ...plan, blocks: plan.blocks.map((x) => (x.id === b.id ? moved : x)) }
    const p = plan.projects.find((x) => x.id === to.projectId)
    const person = plan.people.find((x) => x.id === to.personId)
    const pf = projectFacts(next, to.projectId)
    const lf = person && personFacts(next, person.id, today)
    d.blocked = overlapsOnLine(next, to.projectId, to.personId, r.s, r.e, b.id, to.personId ? 0 : to.slot)
    d.el.classList.toggle('opacity-50', d.blocked)
    const lines: ReactNode[] = []
    if (d.blocked) lines.push(<b>Overlaps another block on that line. Let go to cancel.</b>)
    if (d.target)
      lines.push(
        <b>
          → {person?.name ?? 'Not assigned yet'} on {p?.name}
        </b>,
      )
    lines.push(
      <>
        <b>{range(r.s, r.e)}</b> · {fmtMd(manDays(moved))} man-days
      </>,
    )
    if (p)
      lines.push(
        `${p.name}: ${fmtMd(pf.scheduled)}${p.plannedMd !== null ? ` / ${fmtMd(p.plannedMd)}` : ''} man-days${pf.status !== 'none' ? ` · ${STATUS_WORD[pf.status]}` : ''}`,
      )
    if (lf)
      lines.push(
        lf.overFrom !== null ? <b>{`${person!.name} ${lf.peak}% from ${dayDate(lf.overFrom)}`}</b> : `${person!.name} fits (busiest day ${lf.peak}%)`,
      )
    tipStore.set({ x: d.last.x, y: d.last.y, lines, bad: d.blocked })
  }

  // Near the sheet's edges while dragging, it scrolls.
  const autoScroll = () => {
    const d = drag.current
    const s = scroller.current
    if (!d || !s) return
    const r = s.getBoundingClientRect()
    const vx = edgeSpeed(d.last.x, r.left + left, r.right)
    const vy = edgeSpeed(d.last.y, r.top + HEADER_H, r.bottom)
    if (vx || vy) {
      s.scrollBy(vx, vy)
      follow()
    }
    frame.current = requestAnimationFrame(autoScroll)
  }

  const endDrag = (commit: boolean) => {
    const d = drag.current
    drag.current = null
    cancelAnimationFrame(frame.current)
    tipStore.set(null)
    setBusy(false)
    if (!d) return
    d.target?.closest('[data-row]')?.classList.remove('bg-primary/8')
    // Back as React drew it; the change (if any) redraws it where it now is.
    Object.assign(d.el.style, d.style)
    d.el.classList.remove('z-20', 'shadow-lg', 'cursor-grabbing', 'opacity-50')
    if (!d.moved) return
    afterDrag.current = true
    const r = spanFor(d)
    const b = block(d.id)
    if (!commit || !b) return
    const to = d.target ? lineTarget(d.target) : null
    if (r.s === d.s && r.e === d.e && !to) return
    if (d.blocked) return void run({ type: 'block.update', id: b.id, fields: { start: fromDay(r.s), end: fromDay(r.e), ...to } })
    const who = to ? (plan.people.find((p) => p.id === to.personId)?.name ?? 'Not assigned yet') : null
    run(
      { type: 'block.update', id: b.id, fields: { start: fromDay(r.s), end: fromDay(r.e), ...(to ?? {}) } },
      to ? `Moved to ${who} on ${plan.projects.find((p) => p.id === to.projectId)?.name}` : undefined,
    )
  }

  // ── Rearranging projects and people: drag a group's grip, or arrow keys on it ──
  const groups = useMemo(() => {
    const out: Group[] = []
    let y = HEADER_H
    let cur: Group | null = null
    for (const r of rows) {
      const h = ROW_HEIGHT[r.kind]
      if (r.kind === 'project' || r.kind === 'person') {
        const section = r.kind === 'person' ? 'people' : r.project.finishedAt ? 'finished' : r.project.prospect ? 'prospect' : 'running'
        const g = r.kind === 'project' ? { id: r.project.id, name: r.project.name } : { id: r.person.id, name: r.person.name }
        cur = { kind: r.kind, ...g, section, top: y, bottom: y + h }
        out.push(cur)
      } else if (r.kind === 'heading') cur = null
      else if (cur) cur.bottom = y + h
      y += h
    }
    return out
  }, [rows])
  const reorder = useRef<Reorder | null>(null)
  const dropLine = useRef<HTMLDivElement>(null)
  const peers = (kind: Group['kind'], section: string) => groups.filter((g) => g.kind === kind && g.section === section)
  const moveGroup = (kind: Group['kind'], id: string, before: string | undefined) =>
    run(kind === 'project' ? { type: 'project.move', id, beforeId: before } : { type: 'person.move', id, beforeId: before })

  const followReorder = () => {
    const r = reorder.current
    const line = dropLine.current
    if (!r || !line || !content.current) return
    const y = r.last.y - content.current.getBoundingClientRect().top
    const same = peers(r.kind, r.section)
    let i = same.findIndex((g) => y < (g.top + g.bottom) / 2)
    if (i < 0) i = same.length
    const from = same.findIndex((g) => g.id === r.id)
    r.before = i === from || i === from + 1 ? null : same[i]?.id
    line.hidden = r.before === null
    line.style.top = `${(i < same.length ? same[i].top : same[same.length - 1].bottom) - 1}px`
    tipStore.set({
      x: r.last.x,
      y: r.last.y,
      lines: [<b key="name">{r.name}</b>, r.before === null ? 'Drag up or down' : 'Let go to put it here'],
      bad: false,
    })
  }
  const reorderScroll = () => {
    const r = reorder.current
    const s = scroller.current
    if (!r || !s) return
    const box = s.getBoundingClientRect()
    const vy = edgeSpeed(r.last.y, box.top + HEADER_H, box.bottom)
    if (vy) {
      s.scrollBy(0, vy)
      followReorder()
    }
    frame.current = requestAnimationFrame(reorderScroll)
  }
  const startReorder = (e: React.PointerEvent, grip: HTMLElement) => {
    const g = groups.find((x) => x.kind === grip.dataset.gripKind && x.id === grip.dataset.grip)
    if (!g) return
    const row = grip.closest('[data-row]') as HTMLElement | null
    row?.classList.add('opacity-60')
    reorder.current = { kind: g.kind, id: g.id, name: g.name, section: g.section, row, last: { x: e.clientX, y: e.clientY }, before: null }
    grip.setPointerCapture(e.pointerId)
    hideHover()
    setBusy(true)
    followReorder()
    frame.current = requestAnimationFrame(reorderScroll)
    e.preventDefault()
  }
  const endReorder = (commit: boolean) => {
    const r = reorder.current
    reorder.current = null
    cancelAnimationFrame(frame.current)
    tipStore.set(null)
    setBusy(false)
    if (dropLine.current) dropLine.current.hidden = true
    r?.row?.classList.remove('opacity-60')
    if (commit && r && r.before !== null) moveGroup(r.kind, r.id, r.before)
  }
  /** Arrow keys on a grip: one place up or down among its own. */
  const reorderKey = (e: React.KeyboardEvent, grip: HTMLElement) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const kind = grip.dataset.gripKind as Group['kind']
    const g = groups.find((x) => x.kind === kind && x.id === grip.dataset.grip)
    if (!g) return
    const same = peers(kind, g.section)
    const i = same.findIndex((x) => x.id === g.id)
    if (e.key === 'ArrowUp' ? i === 0 : i === same.length - 1) return
    const before = e.key === 'ArrowUp' ? same[i - 1].id : same[i + 2]?.id
    if (moveGroup(kind, g.id, before))
      requestAnimationFrame(() =>
        (content.current?.querySelector(`[data-grip="${g.id}"][data-grip-kind="${kind}"]`) as HTMLElement | null)?.focus({ preventScroll: true }),
      )
  }

  const onPointerDown = (e: React.PointerEvent) => {
    afterDrag.current = false
    const t = e.target as HTMLElement
    const grip = t.closest('[data-grip]') as HTMLElement | null
    if (grip) return void (canEdit && e.button === 0 && startReorder(e, grip))
    if (!canEdit || coarse || e.button !== 0 || e.pointerType === 'touch' || t.closest('[data-split]')) return
    const bar = t.closest('[data-block]') as HTMLElement | null
    const b = bar && block(bar.dataset.block!)
    if (!bar || !b) return
    const s = scroller.current!
    drag.current = {
      id: b.id,
      el: bar,
      home: lineOf(bar),
      mode: ((t.closest('[data-handle]') as HTMLElement | null)?.dataset.handle as 'start' | 'end') ?? 'move',
      x0: e.clientX,
      y0: e.clientY,
      scroll0: { left: s.scrollLeft, top: s.scrollTop },
      s: toDay(b.start),
      e: toDay(b.end),
      delta: 0,
      moved: false,
      target: null,
      blocked: false,
      last: { x: e.clientX, y: e.clientY },
      style: { left: bar.style.left, width: bar.style.width, transform: bar.style.transform },
    }
    bar.setPointerCapture(e.pointerId)
    setBusy(true)
    frame.current = requestAnimationFrame(autoScroll)
    e.preventDefault()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (reorder.current) {
      reorder.current.last = { x: e.clientX, y: e.clientY }
      return followReorder()
    }
    const d = drag.current
    if (!d) return hover(e)
    d.last = { x: e.clientX, y: e.clientY }
    follow()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        e.preventDefault()
        endDrag(false)
      }
      if (e.key === 'Escape' && reorder.current) {
        e.preventDefault()
        endReorder(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Clicks: scissors, a block (its menu), free space (adds a block) ────────
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-split]')) {
      const m = mark.current!
      hideHover()
      return void run({ type: 'block.split', id: m.dataset.block!, at: fromDay(Number(m.dataset.day)) }, `Split on ${dayDate(Number(m.dataset.day))}`)
    }
    const bar = t.closest('[data-block]') as HTMLElement | null
    if (bar) {
      if (afterDrag.current) return void (afterDrag.current = false)
      const b = block(bar.dataset.block!)
      const track = lineOf(bar)
      if (b && track) openBlockMenu(b.id, canEdit ? splitDayAt(b, e.clientX, track) : null, { x: e.clientX, y: e.clientY })
      return
    }
    const track = lineOf(t)
    if (!track || !canEdit || t.closest('button, a, input, [role=combobox]')) return
    const slot = Number(track.dataset.slot ?? 0)
    const r = freeRangeAt(plan, track.dataset.project!, track.dataset.person || null, Math.max(start, dayAt(e.clientX, track)), addSize, slot)
    if (!r) return
    const id = newId()
    hideHover()
    if (
      run({
        type: 'block.add',
        id,
        projectId: track.dataset.project!,
        personId: track.dataset.person || null,
        slot,
        start: fromDay(r.start),
        end: fromDay(r.end),
        pct: 100,
      })
    )
      setFlash(id)
  }
  const onContextMenu = (e: React.MouseEvent) => {
    const bar = (e.target as HTMLElement).closest('[data-block]') as HTMLElement | null
    const b = bar && block(bar.dataset.block!)
    if (!bar || !b) return
    e.preventDefault()
    openBlockMenu(b.id, canEdit ? splitDayAt(b, e.clientX, lineOf(bar)!) : null, { x: e.clientX, y: e.clientY })
  }

  // ── Keyboard on a block: arrows move it a day, Shift+arrows its end, Enter its menu, Delete removes it ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    const grip = (e.target as HTMLElement).closest('[data-grip]') as HTMLElement | null
    if (grip) return canEdit ? reorderKey(e, grip) : undefined
    const bar = (e.target as HTMLElement).closest('[data-block]') as HTMLElement | null
    const b = bar && block(bar.dataset.block!)
    if (!bar || !b) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const r = bar.getBoundingClientRect()
      const track = lineOf(bar)!
      return openBlockMenu(b.id, canEdit ? splitDayAt(b, r.left + r.width / 2, track) : null, { x: r.left + 8, y: r.bottom })
    }
    if (!canEdit) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = e.key === 'ArrowRight' ? 1 : -1
      const s = toDay(b.start)
      const en = toDay(b.end)
      const fields = e.shiftKey ? { end: fromDay(Math.max(s, en + step)) } : { start: fromDay(s + step), end: fromDay(en + step) }
      if (run({ type: 'block.update', id: b.id, fields })) requestAnimationFrame(() => focusBlock(b.id))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      run({ type: 'block.remove', id: b.id }, 'Block removed')
    }
  }
  const focusBlock = (id: string) => (content.current?.querySelector(`[data-block="${id}"]`) as HTMLElement | null)?.focus({ preventScroll: true })
  useEffect(() => {
    if (flash) focusBlock(flash)
  }, [flash])

  // Grid lines: a line a week (on Mondays), and in days each day too, with weekends shaded; in months, a line a month.
  const weekW = 7 * dayW
  const grid: CSSProperties = useMemo(() => {
    if (zoom === 'days')
      return {
        backgroundImage: `linear-gradient(to right, var(--grid-line) 1px, transparent 1px), repeating-linear-gradient(to right, transparent 0 ${5 * dayW}px, var(--weekend) ${5 * dayW}px ${weekW}px)`,
        backgroundSize: `${weekW}px 100%, auto`,
      }
    if (zoom === 'weeks')
      return { backgroundImage: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px)', backgroundSize: `${weekW}px 100%` }
    // Months aren't all as long: one 1px line placed at each.
    return {
      backgroundImage: minor.map(() => 'linear-gradient(var(--grid-line), var(--grid-line))').join(', '),
      backgroundPosition: minor.map((m) => `${x(m.day)}px 0`).join(', '),
      backgroundSize: '1px 100%',
      backgroundRepeat: 'no-repeat',
    }
  }, [zoom, dayW, weekW, minor, x])

  return (
    <>
      <div
        ref={scroller}
        className="h-full overflow-auto"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (reorder.current ? endReorder(true) : endDrag(true))}
        onPointerCancel={() => (reorder.current ? endReorder(false) : endDrag(false))}
        onPointerLeave={() => !drag.current && hideHover()}
        onClick={onClick}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        <div ref={content} className="relative" style={{ width: left + width }}>
          <div className="sticky top-0 z-30 flex border-b bg-background">
            <div
              className="sticky left-0 z-40 flex shrink-0 items-end border-r bg-background px-4 pb-2 text-xs font-medium text-muted-foreground"
              style={{ width: left, height: HEADER_H }}
            >
              {rows[0]?.kind === 'person' || rows[0]?.kind === 'heading' ? 'Person · projects' : 'Project · people'}
            </div>
            <div className="relative shrink-0" style={{ width, height: HEADER_H }}>
              {/* Each month (year, in months) reaches to the next, its name staying in view until the next one comes. */}
              {months.map((m, i) => (
                <div
                  key={m.day}
                  className="absolute top-1.5 h-4 border-l"
                  style={{ left: x(m.day), width: x(months[i + 1]?.day ?? end + 1) - x(m.day) }}
                >
                  <span className="sticky inline-block pr-2 pl-2 text-xs font-semibold whitespace-nowrap" style={{ left: left }}>
                    {m.label}
                  </span>
                </div>
              ))}
              {minor.map((m) => (
                <span
                  key={m.day}
                  className={cn(
                    'absolute top-7 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums',
                    zoom === 'days' ? 'text-center' : 'border-l border-grid-line pl-1.5',
                    m.weekend && 'text-muted-foreground/50',
                    m.today && 'font-bold text-primary',
                  )}
                  style={{ left: x(m.day), width: zoom === 'days' ? dayW : undefined }}
                >
                  {m.label}
                </span>
              ))}
            </div>
          </div>

          {rows.map((r) => (
            <Row key={r.key} row={r} {...props} left={left} width={width} x={x} dayW={dayW} start={start} end={end} grid={grid} flash={flash} />
          ))}

          {/* Today */}
          <div
            className="pointer-events-none absolute bottom-0 z-10 w-0.5 bg-primary/50"
            style={{ left: left + x(today) + dayW / 2 - 1, top: HEADER_H }}
          />
          {/* Where a dragged project or person would go */}
          <div ref={dropLine} hidden aria-hidden className="pointer-events-none absolute right-0 left-0 z-30 h-0.5 bg-primary" />
          {/* Where a week would go */}
          <div
            ref={ghost}
            hidden
            aria-hidden
            className="pointer-events-none absolute z-10 grid place-items-center rounded-md border-[1.5px] border-dashed border-muted-foreground/40 bg-primary/5 text-sm text-muted-foreground"
          >
            +
          </div>
          {/* The scissors */}
          <div ref={mark} hidden className="pointer-events-none absolute z-20 w-0 border-l-2 border-dashed border-foreground/70">
            <button
              type="button"
              data-split
              tabIndex={-1}
              aria-label="Split here"
              className="pointer-events-auto absolute -top-[19px] -left-[10px] grid size-[18px] place-items-center rounded-full border bg-background text-foreground shadow-sm hover:bg-foreground hover:text-background"
            >
              <Scissors className="size-3" />
            </button>
          </div>
        </div>
      </div>
      <DragTip />
    </>
  )
}

const STATUS_WORD = { none: '', under: 'Under', fit: 'Fit', over: 'Over' } as const
const STATUS_CLASS = {
  under: 'bg-(--c-amber)/15 text-[color-mix(in_oklab,var(--c-amber)_70%,var(--foreground))]',
  fit: 'bg-status-done/15 text-status-done',
  over: 'bg-destructive/12 text-destructive',
  room: 'bg-primary/10 text-primary',
} as const

/** A project's linked board, opened from its row (if you can open it). */
function BoardLink({ board, id }: { board?: { name: string }; id: string }) {
  const cls = 'ml-auto grid size-6 shrink-0 place-items-center rounded text-muted-foreground'
  return board ? (
    <a
      href={hrefFor({ page: 'board', id })}
      className={cn(cls, 'hover:bg-muted hover:text-foreground')}
      title={`Open its board: ${board.name}`}
      aria-label={`Open its board, ${board.name}`}
    >
      <Kanban className="size-4" />
    </a>
  ) : (
    <span className={cn(cls, 'opacity-50')} title="Linked to a board you can’t open">
      <Kanban className="size-4" />
    </span>
  )
}

/** The caret that folds a project's or person's group. */
function Fold({ open, label, onClick }: { open: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="-ml-2 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-expanded={open}
      aria-label={`${open ? 'Fold' : 'Unfold'} ${label}`}
      title={open ? 'Fold' : 'Unfold'}
      onClick={onClick}
    >
      {open ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
    </button>
  )
}

/** The handle a planner drags a project or person by (or moves with the arrow keys). */
function Grip({ kind, id, name }: { kind: 'project' | 'person'; id: string; name: string }) {
  return (
    <button
      type="button"
      data-grip={id}
      data-grip-kind={kind}
      className="absolute top-1/2 left-0.5 grid h-7 w-3.5 -translate-y-1/2 cursor-grab touch-none place-items-center rounded text-muted-foreground/70 opacity-0 group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
      aria-label={`Move ${name} (arrow keys)`}
      title="Drag to move, or use the arrow keys"
    >
      <DotsSixVertical className="size-3.5" weight="bold" />
    </button>
  )
}

/**
 * Logged of planned on a line ("12.5 of 60 MD"), coloured by how it compares with what was booked until today: less
 * (amber), about right, or more (red). Time logged with nothing booked says so.
 */
function Logged({ row, narrow }: { row: Extract<SheetRow, { kind: 'line' }>; narrow: boolean }) {
  const { md, minutes } = row.logged!
  const slack = Math.max(0.5, row.booked * 0.1)
  const pace = row.empty ? null : md < row.booked - slack ? 'less' : md > row.booked + slack ? 'more' : 'fit'
  const title = [
    `Logged ${formatDuration(minutes)} = ${fmtMd(md)} MD`,
    row.empty ? 'Nothing booked on it' : `booked until today ${fmtMd(row.booked)} MD`,
    !row.empty && `planned in all ${fmtMd(row.md)} MD`,
    pace === 'less' ? 'less than booked so far' : pace === 'more' ? 'more than booked so far' : pace && 'about as booked',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      title={title}
      className={cn(
        'ml-auto shrink-0 text-xs tabular-nums',
        pace === 'less'
          ? 'text-[color-mix(in_oklab,var(--c-amber)_70%,var(--foreground))]'
          : pace === 'more'
            ? 'text-destructive'
            : pace === 'fit'
              ? 'text-foreground'
              : 'text-muted-foreground italic',
      )}
    >
      {row.empty ? `${fmtMd(md)} MD logged` : narrow ? `${fmtMd(md)} / ${fmtMd(row.md)}` : `${fmtMd(md)} of ${fmtMd(row.md)} MD`}
    </span>
  )
}

/** A project that might not happen. */
function ProspectChip() {
  return (
    <span className="shrink-0 rounded-full border border-dashed border-muted-foreground/60 px-2 py-px text-[11px] font-semibold text-muted-foreground">
      Prospect
    </span>
  )
}

function Chip({ status, children }: { status: keyof typeof STATUS_CLASS; children: ReactNode }) {
  return <span className={cn('shrink-0 rounded-full px-2 py-px text-[11px] font-semibold', STATUS_CLASS[status])}>{children}</span>
}

interface RowProps extends Props {
  row: SheetRow
  left: number
  width: number
  x: (d: number) => number
  dayW: number
  start: number
  end: number
  grid: CSSProperties
  flash: string | null
}

const Row = memo(function Row(p: RowProps) {
  const { row, left, width, x, start, end, dayW, plan, canEdit } = p
  const height = ROW_HEIGHT[row.kind]
  const cell = 'sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 border-r bg-background px-4'
  const group = row.kind === 'project' || row.kind === 'person' || row.kind === 'heading'

  if (row.kind === 'project') {
    const { project: pr, facts } = row
    const act = p.activity[pr.id]
    const diff = facts.diff === 0 ? '±0' : `${facts.diff > 0 ? '+' : '−'}${fmtMd(Math.abs(facts.diff))}`
    const md = `${fmtMd(facts.scheduled)}${pr.plannedMd !== null ? ` / ${fmtMd(pr.plannedMd)}` : ''} MD`
    // Two short lines; the rest is in the tooltip.
    const more = [
      pr.client,
      `${fmtMd(facts.scheduled)} man-days scheduled${pr.plannedMd !== null ? ` of ${fmtMd(pr.plannedMd)} planned (${diff})` : ', no plan yet'}`,
      facts.unassigned > 0 && `${fmtMd(facts.unassigned)} not assigned yet`,
      row.actual &&
        `${fmtMd(row.actual.md)} MD logged${pr.plannedMd !== null ? ` of ${fmtMd(pr.plannedMd)} planned` : ''} (booked until today: ${fmtMd(row.booked)})` +
          (row.actual.others.minutes ? `, ${fmtMd(row.actual.others.md)} MD of it by others` : ''),
      act && `Changed ${formatAgo(act.at)}${act.by ? ` by ${act.by}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n')
    // A prospect's row is paper, not grey, with a dashed edge: like its blocks, pencilled in.
    const bg = pr.prospect ? 'bg-background' : 'bg-muted/40'
    return (
      <div data-row className={cn('group/row flex border-b', bg, pr.prospect && 'border-dashed border-muted-foreground/40')} style={{ height }}>
        <div
          className={cn(cell, bg, 'pl-5 backdrop-blur-sm')}
          style={{ width: left }}
          title={pr.prospect ? `Prospect: might not happen\n${more}` : more}
        >
          <div className="flex min-w-0 items-center gap-2">
            {canEdit && <Grip kind="project" id={pr.id} name={pr.name} />}
            <Fold open={!row.collapsed} label={pr.name} onClick={() => p.toggleGroup(row.key)} />
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: tone(pr.color) }} />
            <button type="button" className="min-w-0 truncate text-left text-sm font-semibold hover:underline" onClick={() => p.editProject(pr.id)}>
              {pr.name}
            </button>
            {pr.prospect && <ProspectChip />}
            {facts.status !== 'none' && <Chip status={facts.status}>{STATUS_WORD[facts.status]}</Chip>}
            {pr.boardId && <BoardLink board={p.boards.find((b) => b.id === pr.boardId)} id={pr.boardId} />}
          </div>
          <div className="truncate pl-[18px] text-xs text-muted-foreground">
            <span className="text-foreground tabular-nums">{md}</span>
            {pr.plannedMd !== null && <span className="tabular-nums"> · {diff}</span>}
            {pr.client && <span> · {pr.client}</span>}
          </div>
        </div>
        <div className="relative shrink-0" style={{ width, ...p.grid }}>
          {facts.start !== null && facts.end! >= start && facts.start <= end && (
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full opacity-35"
              style={{
                left: x(Math.max(facts.start, start)),
                width: x(Math.min(facts.end!, end) + 1) - x(Math.max(facts.start, start)),
                background: pr.prospect ? `repeating-linear-gradient(90deg, ${tone(pr.color)} 0 6px, transparent 6px 10px)` : tone(pr.color),
              }}
            />
          )}
        </div>
      </div>
    )
  }

  if (row.kind === 'person') {
    const { person, role, facts, left: gone } = row
    const room = 100 - facts.nowLoad
    const status = facts.status === 'under' ? 'room' : facts.status
    const now = room > 0 ? `${room}% free now` : room === 0 ? 'Fully booked now' : `Booked ${facts.nowLoad}% now`
    // Time on prospects ahead isn't booked yet, but isn't nothing either.
    const prospectsAhead = personBlocks(plan, person.id).maybe.some((b) => toDay(b.end) >= p.today)
    const free =
      facts.freeFrom !== null ? `free from ${dayDate(facts.freeFrom)}` : prospectsAhead ? 'nothing confirmed ahead' : 'nothing booked ahead'
    const over = facts.overFrom !== null ? `${facts.peak}% from ${dayDate(facts.overFrom)} to ${dayDate(facts.overTo!)}` : null
    // Over only if prospects they're on happen.
    const names = facts.ifProjects.map((id) => plan.projects.find((x) => x.id === id)?.name ?? '').filter(Boolean)
    const maybe =
      facts.ifFrom !== null ? `${facts.ifLoad}% if ${names.length === 1 ? `${names[0]} happens` : `${names.length} prospects happen`}` : null
    const maybeMore =
      facts.ifFrom !== null
        ? `If ${names.join(' and ')} ${names.length === 1 ? 'happens' : 'happen'}: ${facts.ifLoad}% from ${dayDate(facts.ifFrom)}`
        : null
    const more = [gone && 'Left the workspace', `${person.hoursPerDay} hours a day`, now, `All ${free}`, over && `Over: ${over}`, maybeMore]
      .filter(Boolean)
      .join('\n')
    return (
      <div data-row className="group/row flex border-b bg-muted/40" style={{ height }}>
        <div className={cn(cell, 'bg-muted/40 pl-5 backdrop-blur-sm')} style={{ width: left }} title={more}>
          <div className="flex min-w-0 items-center gap-2">
            {canEdit && <Grip kind="person" id={person.id} name={person.name} />}
            <Fold open={!row.collapsed} label={person.name} onClick={() => p.toggleGroup(row.key)} />
            <Avatar name={person.name} className="size-5 text-[9px]" />
            <button
              type="button"
              className="min-w-0 truncate text-left text-sm font-semibold hover:underline"
              onClick={() => p.editPerson(person.id)}
            >
              {person.name}
            </button>
            {role && <span className="shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground">{role.name}</span>}
            <Chip status={status}>{facts.status === 'under' ? 'Under' : STATUS_WORD[facts.status]}</Chip>
          </div>
          <div className="truncate pl-7 text-xs text-muted-foreground">
            {gone ? (
              <span className="text-destructive">Left the workspace</span>
            ) : over ? (
              <span className="text-destructive">{over}</span>
            ) : maybe ? (
              <span className="text-[color-mix(in_oklab,var(--c-amber)_70%,var(--foreground))]">{maybe}</span>
            ) : (
              <span>{now}</span>
            )}
            <span> · {free}</span>
          </div>
        </div>
        <div className="relative shrink-0" style={{ width, ...p.grid }}>
          <LoadCells plan={plan} personId={person.id} zoom={p.zoom} start={start} end={end} x={x} dayW={dayW} today={p.today} />
        </div>
      </div>
    )
  }

  if (row.kind === 'heading')
    return (
      <div data-row className="flex border-b bg-muted/60" style={{ height }}>
        <div className={cn(cell, 'flex-row items-center justify-start gap-2 bg-muted/60')} style={{ width: left }}>
          {row.toggle ? (
            <button type="button" className="text-sm font-semibold hover:underline" onClick={p.toggleFinished} aria-expanded={row.open}>
              {row.open ? '▾' : '▸'} {row.title}
            </button>
          ) : (
            <span className="text-sm font-semibold">{row.title}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center px-3 text-xs text-muted-foreground" style={{ width }}>
          <span className="sticky" style={{ left: left + 12 }}>
            {row.detail}
          </span>
        </div>
      </div>
    )

  if (row.kind === 'add-person' || row.kind === 'add-project')
    return (
      <div data-row className="flex border-b" style={{ height }}>
        <div className={cn(cell, 'items-start pl-8')} style={{ width: left }}>
          {row.kind === 'add-person' ? (
            <AddPersonPicker
              options={row.options}
              plan={plan}
              onPick={(personId) => p.run({ type: 'line.add', projectId: row.projectId, personId })}
              onNew={() => p.newPerson(row.projectId)}
              onOpenLine={() => p.run({ type: 'project.addOpenLine', id: row.projectId })}
            />
          ) : (
            <AddProjectPicker options={row.options} onPick={(projectId) => p.run({ type: 'line.add', projectId, personId: row.personId })} />
          )}
        </div>
        <div className="shrink-0" style={{ width, ...p.grid }} />
      </div>
    )

  // A line: one person (or nobody) on one project, with its blocks.
  const project = plan.projects.find((x) => x.id === row.projectId)
  const person = row.personId ? plan.people.find((x) => x.id === row.personId) : null
  if (!project) return null
  const color = tone(project.color)
  const role = person?.roleId ? plan.roles.find((r) => r.id === person.roleId) : null
  return (
    <div data-row className={cn('flex border-b transition-colors', group && 'bg-muted/40')} style={{ height }}>
      <div className={cn(cell, 'flex-row items-center justify-start gap-2 pl-8')} style={{ width: left }}>
        {row.label === 'person' ? (
          person ? (
            <>
              {!p.narrow && <Avatar name={person.name} className="size-5 text-[9px]" />}
              <button type="button" className="min-w-0 truncate text-left text-sm hover:underline" onClick={() => p.editPerson(person.id)}>
                {person.name}
              </button>
              {role && !p.narrow && <span className="shrink-0 rounded border px-1 text-[10px] font-medium text-muted-foreground">{role.name}</span>}
            </>
          ) : (
            <span className="min-w-0 truncate pr-0.5 text-sm whitespace-nowrap text-muted-foreground italic">
              Not assigned yet{row.openLines > 1 && ` ${row.slot + 1}`}
            </span>
          )
        ) : (
          <>
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
            <button type="button" className="min-w-0 truncate text-left text-sm hover:underline" onClick={() => p.editProject(project.id)}>
              {project.name}
            </button>
            {!person && <span className="shrink-0 text-xs text-muted-foreground italic">not assigned{row.openLines > 1 && ` ${row.slot + 1}`}</span>}
          </>
        )}
        {row.logged ? (
          <Logged row={row} narrow={p.narrow} />
        ) : (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {row.empty ? (person ? 'no time yet' : '') : `${fmtMd(row.md)} MD`}
          </span>
        )}
        {row.empty && !person && row.label === 'person' && row.openLines > 1 && canEdit && (
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Take this line away"
            title="Take this “not assigned yet” line away"
            onClick={() => p.run({ type: 'project.removeOpenLine', id: project.id, slot: row.slot })}
          >
            <X className="size-3" />
          </button>
        )}
        {row.empty && person && canEdit && !row.logged && (
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Take ${person.name} off ${project.name}`}
            title={`Take ${person.name} off ${project.name}`}
            onClick={() => p.run({ type: 'line.remove', projectId: project.id, personId: person.id })}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <div
        data-line=""
        data-project={project.id}
        data-person={row.personId ?? ''}
        data-slot={row.slot}
        className={cn('relative shrink-0', canEdit && !p.coarse && 'cursor-cell')}
        style={{ width, ...p.grid }}
        title={canEdit && !p.coarse ? 'Click to add a week here' : undefined}
      >
        {row.blocks.map((b) => (
          <Block
            key={b.id}
            block={b}
            color={color}
            prospect={project.prospect}
            label={row.label === 'person' ? `${b.pct}% · ${fmtMd(manDays(b))} MD` : `${project.name} · ${b.pct}%`}
            {...p}
          />
        ))}
      </div>
    </div>
  )
})

function Block({
  block: b,
  color,
  label,
  x,
  start,
  end,
  dayW,
  canEdit,
  coarse,
  flash,
  plan,
  left,
  prospect,
}: RowProps & { block: PlanBlock; color: string; label: string; prospect: boolean }) {
  const s = Math.max(toDay(b.start), start)
  const e = Math.min(toDay(b.end), end)
  if (s > e) return null
  const who = b.personId ? (plan.people.find((p) => p.id === b.personId)?.name ?? 'Someone') : 'Not assigned yet'
  const project = plan.projects.find((p) => p.id === b.projectId)?.name ?? ''
  const handles = canEdit && !coarse
  return (
    <div
      role="button"
      tabIndex={0}
      data-block={b.id}
      aria-label={`${who} on ${project}${prospect ? ' (prospect)' : ''}, ${b.pct}%, ${range(toDay(b.start), toDay(b.end))}, ${fmtMd(manDays(b))} man-days`}
      title={`${prospect ? 'Prospect · ' : ''}${who} · ${range(toDay(b.start), toDay(b.end))} · ${b.pct}% · ${fmtMd(manDays(b))} man-days`}
      className={cn(
        'absolute top-1.5 bottom-1.5 flex items-stretch rounded-md border text-[11px] font-medium text-foreground select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        handles ? 'cursor-grab' : 'cursor-pointer',
        flash === b.id && 'ring-2 ring-primary',
        // A prospect: pencilled in, dashed and paler.
        prospect && 'border-[1.5px] border-dashed text-foreground/80',
      )}
      style={{
        left: x(s),
        width: Math.max(dayW, x(e + 1) - x(s)),
        borderColor: color,
        backgroundColor: `color-mix(in oklab, ${color} ${(b.personId ? 30 : 14) / (prospect ? 2.5 : 1)}%, var(--background))`,
        backgroundImage: b.personId
          ? undefined
          : `repeating-linear-gradient(135deg, color-mix(in oklab, ${color} 30%, transparent) 0 4px, transparent 4px 9px)`,
      }}
    >
      {handles && <span data-handle="start" className="relative z-10 w-1.5 shrink-0 cursor-ew-resize rounded-l-md hover:bg-foreground/15" />}
      <span className="sticky min-w-0 flex-1 self-center truncate px-1 tabular-nums" style={{ left: left + 4 }}>
        {label}
      </span>
      {handles && <span data-handle="end" className="relative z-10 w-1.5 shrink-0 cursor-ew-resize rounded-r-md hover:bg-foreground/15" />}
    </div>
  )
}

/** A person's load: each working day (days), or each week's or month's busiest day; over 100% in red. */
function LoadCells({
  plan,
  personId,
  zoom,
  start,
  end,
  x,
  dayW,
  today,
}: {
  plan: PlanData
  personId: string
  zoom: Zoom
  start: number
  end: number
  x: (d: number) => number
  dayW: number
  today: number
}) {
  const { confirmed, maybe } = personBlocks(plan, personId)
  if (!confirmed.length && !maybe.length) return null
  const spans = confirmed.map(spanOf)
  const maybeSpans = maybe.map(spanOf)
  /** The busiest working day's confirmed load, and how much more the busiest day would be if prospects happen. */
  const busiest = (from: number, to: number) => {
    let load = 0
    let all = 0
    for (let d = from; d <= to; d++)
      if (isWorkDay(d)) {
        const l = loadOn(spans, d)
        load = Math.max(load, l)
        all = Math.max(all, l + loadOn(maybeSpans, d))
      }
    return { load, extra: all - load }
  }
  const cells: { day: number; days: number; width: number; load: number; extra: number }[] = []
  if (zoom === 'days') {
    for (let d = start; d <= end; d++) if (isWorkDay(d)) cells.push({ day: d, days: 1, width: dayW, ...busiest(d, d) })
  } else if (zoom === 'weeks') {
    for (let m = start; m <= end; m += 7) cells.push({ day: m, days: 7, width: 7 * dayW, ...busiest(m, m + 6) })
  } else {
    // Months: from the sheet's first day (partway through a month) to its last.
    for (let m = start; m <= end; m = monthEndOf(m) + 1) {
      const e = Math.min(monthEndOf(m), end)
      cells.push({ day: m, days: e - m + 1, width: (e - m + 1) * dayW, ...busiest(m, e) })
    }
  }
  return (
    <>
      {cells
        .filter((c) => c.load || c.extra)
        .map((c) => (
          <div
            key={c.day}
            title={`${zoom === 'days' ? dayDate(c.day) : `${zoom === 'weeks' ? `Week of ${dayDate(c.day)}` : monthName(c.day)}, busiest day`}: ${c.load}%${c.extra ? ` (${c.load + c.extra}% if prospects happen)` : ''}`}
            className={cn(
              'absolute top-1/2 flex h-6 -translate-y-1/2 items-center justify-center gap-0.5 rounded text-[10px] font-medium tabular-nums',
              c.load > 100
                ? 'bg-destructive/20 font-semibold text-destructive'
                : c.load === 100
                  ? 'bg-status-done/25 text-foreground'
                  : c.load
                    ? 'bg-primary/12 text-foreground'
                    : 'text-muted-foreground',
              // Prospects on top: a dashed edge, and their share in grey.
              c.extra > 0 && 'border border-dashed border-muted-foreground/50',
              c.day + c.days <= today && 'opacity-45',
            )}
            style={{ left: x(c.day) + 1.5, width: c.width - 3 }}
          >
            {c.width >= (c.load && c.extra ? 44 : 22) ? (
              <>
                {c.load > 0 && <span>{c.load}</span>}
                {c.extra > 0 && <span className="font-normal text-muted-foreground">+{c.extra}</span>}
              </>
            ) : c.width >= 22 ? (
              c.load || `+${c.extra}`
            ) : (
              ''
            )}
          </div>
        ))}
    </>
  )
}
