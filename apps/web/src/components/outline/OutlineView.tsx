import { ArrowDown, ArrowUp, ArrowsDownUp, CaretDown, CaretRight, Crosshair, DotsSixVertical, Plus, Prohibit, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar, DueChip, LabelChip, PriorityIcon, ProgressBar, StatusDot } from '@/components/common/bits'
import { FieldChip } from '@/components/fields/FieldValue'
import { pointerDrag } from '@/lib/pointerDrag'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { FieldCell } from './FieldCell'
import { OutlineDisplayMenu } from './OutlineDisplayMenu'
import { PRIORITY_LABEL } from '@kanbanto/model/types'
import { Empty } from '@/components/common/Empty'
import { StatusMenu } from '@/components/common/StatusMenu'
import { QuickAdd } from '@/components/board/QuickAdd'
import { ViewActions } from '@/components/shell/ViewBar'
import { FoldAll } from '@/components/tree/FoldAll'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDay, formatMoment, formatShortDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fieldIdOf, fieldKey, isFieldKey, numberText, type BoardField, type FieldType, type FieldValue } from '@kanbanto/model/fields'
import { isBlocked, statusCol } from '@kanbanto/model/indexer'
import {
  arrangeColumns,
  changedAt,
  isExtraColumn,
  moveColumn,
  OUTLINE_EXTRA,
  sortComparator,
  type BuiltInSortKey,
  type ColumnKey,
  type Sort,
  type SortKey,
} from '@kanbanto/model/table'
import { refOf } from '@kanbanto/model/refs'
import { subtreeSums, sumOf } from '@kanbanto/model/totals'
import { afterSubtree, defaultExpanded, flattenTree, treeTop } from '@kanbanto/model/tree'
import { FilterMenu } from '@/components/shell/FilterMenu'
import { PresetMenu } from '@/components/shell/PresetMenu'
import { AddSubtaskRow, DropLine } from '@/components/tree/rows'
import { useRowDrag } from '@/components/tree/useRowDrag'
import { HiddenDoneNote } from '@/components/tree/HiddenDone'
import { useTreeFilter } from '@/components/tree/useTreeFilter'

const ROWS_STEP = 500

/**
 * The table's columns. The task column takes the room that's left; the rest are fixed (in rem) so values line up for
 * scanning. Property columns can be switched off in Display. After these come the board's own fields, one each.
 */
interface Column {
  key: SortKey
  label: string
  width: number
  /** One of the board's fields. */
  field?: BoardField
}
const COLUMNS: (Column & { key: BuiltInSortKey })[] = [
  { key: 'title', label: 'Task', width: 18 },
  // (Off until switched on in Display, like Created and Updated.)
  { key: 'number', label: 'Number', width: 6.5 },
  { key: 'status', label: 'Status', width: 8.5 },
  { key: 'progress', label: 'Progress', width: 9.5 },
  { key: 'assignee', label: 'Assignee', width: 9 },
  { key: 'priority', label: 'Priority', width: 6.5 },
  { key: 'start', label: 'Start', width: 6.5 },
  { key: 'due', label: 'Due', width: 6.5 },
  { key: 'labels', label: 'Labels', width: 11 },
  // (Off until switched on in Display: see OUTLINE_EXTRA.)
  { key: 'created', label: 'Created', width: 7 },
  { key: 'updated', label: 'Updated', width: 7 },
]
const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])) as Record<BuiltInSortKey, string>
/** How wide a field's column is, by its kind (in rem): wider for a long name, up to a point, so the heading reads. */
const FIELD_WIDTH: Record<FieldType, number> = { text: 11, number: 8, date: 8.5, choice: 9.5, checkbox: 6, link: 12, person: 10 }
const fieldWidth = (f: BoardField) => Math.max(FIELD_WIDTH[f.type], Math.min(14, 2.5 + f.name.length * 0.42))
const INDENT = 20
/** Width of the drag handle before the indent. */
const HANDLE = 28

/**
 * Everything as one nested table: the task tree on the left, its properties in columns.
 * Sort by clicking a header, filter from "Filter", add subtasks inline, and drag rows to reorder or move them.
 */
export function OutlineView({ search }: { search: string }) {
  const { data, prefs, setPrefs, idx, run, openTask, createTask, focus, memberName, readOnly, links } = useBoard()
  const cfg = prefs.outline
  const setSort = (sort?: Sort) => setPrefs({ type: 'setOutline', config: { ...cfg, sort } })

  const [expanded, setExpanded] = useState(() => defaultExpanded(idx))
  const [limit, setLimit] = useState(ROWS_STEP)
  const [adding, setAdding] = useState<string | null>(null)
  const labelById = useMemo(() => new Map(data.labels.map((l) => [l.id, l])), [data.labels])

  const focusId = prefs.focusId && prefs.focusId in data.tasks ? prefs.focusId : undefined
  const { top, baseDepth } = treeTop(idx, focusId)

  // Search and filters show the matching tasks plus their parents (muted) for context.
  const { keep, matched, counted, filtering, hiddenDone } = useTreeFilter(search)

  // Sorted by a card link, rows go by their linked card's title: sorted again when one of those is learned.
  const byLink = !!cfg.sort && isFieldKey(cfg.sort.key) && idx.fields.get(fieldIdOf(cfg.sort.key))?.type === 'link'
  const titles = useSyncExternalStore(links.subscribeAll, () => (byLink ? links.getVersion() : 0))
  const order = useMemo(() => {
    if (!cfg.sort) return undefined
    const cmp = sortComparator(idx, cfg.sort, labelById, links.titleOf)
    return (ids: string[]) => [...ids].sort(cmp)
    // (`titles` is here to sort again, not to be read.)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, cfg.sort, labelById, links, titles])

  // (Laid out again only when something it's made from changes: on a big board, sorting every list of siblings is the
  // slow part, and a redraw for a menu opening or a cell being edited doesn't need it.)
  // Search and filters show what they found unfolded, and folding is off meanwhile. "Hide done" alone only leaves
  // rows out: folding works as usual.
  const forced = matched !== undefined
  const { rows, truncated } = useMemo(
    () => flattenTree(idx, top, expanded, limit, keep, order, !forced),
    [idx, top, expanded, limit, keep, order, forced],
  )

  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }
  const expand = (id: string) => {
    if (!expanded.has(id)) setExpanded(new Set(expanded).add(id))
  }

  const startAdding = (parentId: string) => {
    expand(parentId)
    setAdding(parentId)
  }

  const { dragId, zoneOf, dragProps, dropProps } = useRowDrag(expand)

  // Phones get a nested list instead of the table (no sideways scrolling).
  const narrow = useMediaQuery('(max-width: 767px)')
  const hidden = useMemo(() => new Set<string>(cfg.hidden ?? []), [cfg.hidden])
  const fieldColumns = useMemo(
    () => (cfg.hideFields ? [] : data.fields.map((f): Column => ({ key: fieldKey(f.id), label: f.name, width: fieldWidth(f), field: f }))),
    [data.fields, cfg.hideFields],
  )
  // Every column after Task there could be, in the order they come in: the built-in ones, then the board's fields.
  // How they've been arranged (hidden ones keep their place in it) decides the order of the ones that show.
  const orderable = useMemo(
    () => [...COLUMNS.slice(1), ...data.fields.map((f): Column => ({ key: fieldKey(f.id), label: f.name, width: fieldWidth(f), field: f }))],
    [data.fields],
  )
  const allKeys = useMemo(() => orderable.map((c) => c.key as ColumnKey), [orderable])
  const columns = useMemo(() => {
    const byKey = new Map(orderable.map((c) => [c.key as string, c]))
    const shown = arrangeColumns(allKeys, cfg.order)
      .map((k) => byKey.get(k)!)
      .filter((c) => (isExtraColumn(c.key) ? !!cfg.extra?.includes(c.key) : !hidden.has(c.key)) && !(c.field && cfg.hideFields))
    return [COLUMNS[0] as Column, ...shown]
  }, [orderable, allKeys, cfg.order, cfg.extra, hidden, cfg.hideFields])
  /** Moves a column to just before another one that shows (null: after the last). */
  const moveBefore = (key: ColumnKey, before: ColumnKey | null) =>
    setPrefs({ type: 'setOutline', config: { ...cfg, order: moveColumn(allKeys, cfg.order, key, before) } })
  // Dragging a column's name: which one, and the one it would land before (null: after the last).
  const [columnDrag, setColumnDrag] = useState<{ key: ColumnKey; before: ColumnKey | null | undefined } | null>(null)
  const headerRow = useRef<HTMLDivElement>(null)
  const dragColumn = (e: React.PointerEvent<HTMLElement>, key: ColumnKey) => {
    const cell = e.currentTarget
    pointerDrag(e, {
      ghost: cell,
      start: () => {
        let before: ColumnKey | null | undefined
        setColumnDrag({ key, before })
        return {
          move: (x) => {
            // Before the first name whose middle is right of the pointer; after the last one otherwise.
            const cells = [...(headerRow.current?.querySelectorAll<HTMLElement>('[data-column]') ?? [])]
            const next = cells.find((c) => {
              const r = c.getBoundingClientRect()
              return x < r.left + r.width / 2
            })
            before = (next?.dataset.column as ColumnKey | undefined) ?? null
            setColumnDrag({ key, before })
          },
          drop: () => before !== undefined && before !== key && moveBefore(key, before),
          end: () => setColumnDrag(null),
        }
      },
    })
  }
  /** With the keyboard: one place to the left or right, among the columns that show. */
  const nudgeColumn = (key: ColumnKey, by: -1 | 1) => {
    const shown = columns.slice(1).map((c) => c.key as ColumnKey)
    const at = shown.indexOf(key)
    const to = at + by
    if (at < 0 || to < 0 || to >= shown.length) return
    moveBefore(key, by < 0 ? shown[to] : (shown[to + 1] ?? null))
  }
  const sortLabel = !cfg.sort
    ? ''
    : isFieldKey(cfg.sort.key)
      ? (idx.fields.get(fieldIdOf(cfg.sort.key))?.name ?? 'a field')
      : COLUMN_LABEL[cfg.sort.key].toLowerCase()

  // Numbers that add up: every card's total with its subtasks, counting the cards that are shown for their own sake
  // (so a parent's total and the bottom line always agree with what's on screen).
  const addingUp = useMemo(() => fieldColumns.flatMap((c) => (c.field?.type === 'number' && c.field.sum ? [c.field] : [])), [fieldColumns])
  const sums = useMemo(() => new Map(addingUp.map((f) => [f.id, subtreeSums(idx, f, counted)])), [idx, addingUp, counted])
  const totalled = columns.some((c) => c.field && sums.has(c.field.id))
  const shownTop = keep ? top.filter((id) => keep.has(id)) : top

  // Cells keep one function for good, whatever else changes around them (see FieldCell).
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })
  const setValue = useCallback((id: string, fieldId: string, value: FieldValue | null) => {
    runRef.current({ type: 'task.update', id, fields: { custom: { [fieldId]: value } } })
  }, [])
  const grid = {
    display: 'grid',
    gridTemplateColumns: `minmax(18rem, 1fr) ${columns
      .slice(1)
      .map((c) => `${c.width}rem`)
      .join(' ')}`,
  }
  const minWidth = `${columns.reduce((sum, c) => sum + c.width, 0)}rem`
  // Compact unless chosen otherwise.
  const compact = cfg.density !== 'comfortable'
  const height = compact ? 'h-8' : 'h-10'

  // Where the inline "add a subtask" field goes: right after the parent's last visible descendant.
  const addAfter = adding ? afterSubtree(idx, rows, adding) : -1

  return (
    <>
      <ViewActions>
        <PresetMenu />
        <FilterMenu />
        <OutlineDisplayMenu />
      </ViewActions>

      <div className="h-full overflow-auto">
        <div className="px-3 py-4 sm:px-6">
          {/* A phone's list has no "Task" heading to hold them. */}
          <div className="mb-1 flex justify-end md:hidden">
            <FoldAll disabled={forced} onExpand={() => setExpanded(new Set(idx.childrenOf.keys()))} onCollapse={() => setExpanded(new Set())} />
          </div>
          {(cfg.sort || matched) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {cfg.sort && (
                <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-3 text-xs">
                  <span className="text-muted-foreground">Sorted by</span>
                  <span className="font-medium">
                    {sortLabel} {cfg.sort.dir === 'asc' ? '↑' : '↓'}
                  </span>
                  <button
                    aria-label="Stop sorting"
                    onClick={() => setSort(undefined)}
                    className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              )}
              {matched && (
                <span className="px-1 text-xs text-muted-foreground">
                  {matched.size.toLocaleString()} {matched.size === 1 ? 'task matches' : 'tasks match'}
                </span>
              )}
              {cfg.sort && <span className="px-1 text-xs text-muted-foreground">· Clear the sort to reorder by dragging</span>}
            </div>
          )}

          {rows.length === 0 ? (
            <Empty>{search || filtering ? 'No tasks match.' : hiddenDone ? 'Everything here is done.' : 'No tasks here yet.'}</Empty>
          ) : narrow ? (
            <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Tasks">
              {rows.map((id) => {
                const t = data.tasks[id]
                const ref = refOf(data.board, t)
                const kids = idx.childrenOf.get(id)
                const open = forced || expanded.has(id)
                const depth = idx.depth.get(id)! - baseDepth
                const done = idx.category.get(id) === 'done'
                const col = statusCol(idx, id)
                const context = matched && !matched.has(id)
                const zone = zoneOf(id)
                return (
                  <li
                    key={id}
                    {...dragProps(id)}
                    {...dropProps(id)}
                    className={cn(
                      'drag-handle relative flex items-start gap-1 py-2 pr-3',
                      !depth && kids && 'bg-muted/40',
                      dragId === id && 'opacity-40',
                      zone === 'inside' && 'bg-primary/8',
                    )}
                    style={{ paddingLeft: 6 + depth * 16 }}
                  >
                    <button
                      disabled={!kids || forced || (!!keep && !kids.some((k) => keep.has(k)))}
                      onClick={() => toggle(id)}
                      aria-label={open ? 'Collapse' : 'Expand'}
                      className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground disabled:opacity-0"
                    >
                      {open ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => openTask(id)}
                        className={cn(
                          'line-clamp-2 text-left text-sm',
                          kids && 'font-semibold',
                          done && !kids && 'text-muted-foreground line-through',
                          context && 'font-normal text-muted-foreground',
                        )}
                      >
                        {t.title}
                      </button>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot category={col.category} color={col.color} /> {col.name}
                        </span>
                        {t.priority && <PriorityIcon priority={t.priority} />}
                        {t.assigneeId && (
                          <span className="inline-flex items-center gap-1">
                            <Avatar name={memberName(t.assigneeId)} picture={idx.members.get(t.assigneeId)?.picture} className="size-4 text-[8px]" />{' '}
                            {memberName(t.assigneeId)}
                          </span>
                        )}
                        {t.due && <DueChip due={t.due} done={done} />}
                        {/* When it was made or last changed, once that column is switched on or sorted by. */}
                        {OUTLINE_EXTRA.map(
                          (k) =>
                            (cfg.extra?.includes(k) || cfg.sort?.key === k) &&
                            (k === 'number' ? (
                              ref && (
                                <span key={k} className="font-mono tabular-nums">
                                  {ref}
                                </span>
                              )
                            ) : (
                              <span key={k}>
                                {COLUMN_LABEL[k]} <When at={k === 'created' ? t.createdAt : changedAt(t)} />
                              </span>
                            )),
                        )}
                        {isBlocked(idx, id) && <Prohibit weight="bold" className="size-3.5 text-warning" aria-label="Waiting on another task" />}
                        {/* No columns here: the fields the board shows on its cards. */}
                        {t.custom &&
                          data.fields.map(
                            (f) => f.front && t.custom![f.id] !== undefined && <FieldChip key={f.id} field={f} value={t.custom![f.id]} />,
                          )}
                      </div>
                    </div>
                    {kids && (
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {idx.subDone.get(id)}/{idx.subTotal.get(id)}
                      </span>
                    )}
                    <DropLine zone={zone} left={6 + depth * 16} />
                  </li>
                )
              })}
            </ul>
          ) : (
            // One scroll area (the page) for both directions, so the header and task column can both stay pinned.
            // overflow-clip rounds the corners without becoming a scroll container.
            <div className="w-full overflow-clip rounded-xl border bg-card" style={{ minWidth }}>
              <div role="table" aria-label="Tasks">
                {/* Header row, pinned while you scroll. Click a column to sort by it. */}
                <div ref={headerRow} role="row" className="sticky top-0 z-20 border-b bg-muted" style={grid}>
                  {columns.map((c, i) => {
                    const on = cfg.sort?.key === c.key ? cfg.sort.dir : undefined
                    // Every column but Task can be moved: by dragging its name, or with Alt+Shift and an arrow.
                    const movable = i > 0
                    const landing = !!columnDrag && columnDrag.key !== c.key && columnDrag.before === c.key
                    const landingAfter = !!columnDrag && columnDrag.before === null && i === columns.length - 1 && columnDrag.key !== c.key
                    return (
                      <div
                        key={c.key}
                        role="columnheader"
                        aria-sort={on === 'asc' ? 'ascending' : on === 'desc' ? 'descending' : 'none'}
                        {...(movable && {
                          'data-column': c.key,
                          onPointerDown: (e: React.PointerEvent<HTMLElement>) => dragColumn(e, c.key as ColumnKey),
                        })}
                        className={cn(
                          'flex h-9 items-center',
                          // The pinned Task column draws its own divider, so columns sliding under it stay separate.
                          i === 0 && 'sticky left-0 z-10 bg-muted shadow-[inset_-1px_0_0_var(--border)]',
                          i > 1 && 'border-l',
                          columnDrag?.key === c.key && 'opacity-40',
                          // Where the column being dragged would go: a line on that side of this one.
                          landing && 'shadow-[inset_3px_0_0_var(--primary)]',
                          landingAfter && 'shadow-[inset_-3px_0_0_var(--primary)]',
                        )}
                        style={i === 0 ? { paddingLeft: HANDLE } : undefined}
                      >
                        <button
                          onClick={() => setSort(!on ? { key: c.key, dir: 'asc' } : on === 'asc' ? { key: c.key, dir: 'desc' } : undefined)}
                          onKeyDown={(e) => {
                            if (!movable || !e.altKey || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                            e.preventDefault()
                            nudgeColumn(c.key as ColumnKey, e.key === 'ArrowLeft' ? -1 : 1)
                          }}
                          aria-keyshortcuts={movable ? 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight' : undefined}
                          title={`${!on ? `Sort by ${c.field ? c.label : c.label.toLowerCase()}` : on === 'asc' ? 'Sort the other way' : 'Stop sorting'}${movable ? '. Drag to move the column' : ''}`}
                          className={cn(
                            'group/sort flex h-full w-full min-w-0 items-center gap-1 px-3 text-left text-xs font-medium hover:text-foreground',
                            on ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          <span className="truncate">{c.label}</span>
                          {on === 'asc' ? (
                            <ArrowUp weight="bold" className="size-3 shrink-0" />
                          ) : on === 'desc' ? (
                            <ArrowDown weight="bold" className="size-3 shrink-0" />
                          ) : (
                            <ArrowsDownUp className="size-3 shrink-0 opacity-0 group-hover/sort:opacity-60" />
                          )}
                        </button>
                        {i === 0 && (
                          <FoldAll
                            className="pr-1.5"
                            disabled={forced}
                            onExpand={() => setExpanded(new Set(idx.childrenOf.keys()))}
                            onCollapse={() => setExpanded(new Set())}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>

                {rows.map((id, i) => {
                  const t = data.tasks[id]
                  const ref = refOf(data.board, t)
                  const kids = idx.childrenOf.get(id)
                  const open = forced || expanded.has(id)
                  const depth = idx.depth.get(id)! - baseDepth
                  const done = idx.category.get(id) === 'done'
                  const context = matched && !matched.has(id) // shown only because a subtask matches
                  const labels = t.labels.map((l) => labelById.get(l)).filter((l) => !!l)
                  const zone = zoneOf(id)
                  // Hover is a solid color (not see-through) so the pinned Task cell can match it.
                  const row = (
                    <div
                      key={id}
                      role="row"
                      {...dragProps(id)}
                      {...dropProps(id)}
                      style={grid}
                      className={cn(
                        // The row's color is a variable, so the pinned Task cell can match it (hover included).
                        'group drag-handle relative border-b bg-(--row) [--row:var(--card)] hover:[--row:color-mix(in_oklab,var(--accent)_45%,var(--card))]',
                        !depth && kids && '[--row:color-mix(in_oklab,var(--muted)_55%,var(--card))]',
                        i === rows.length - 1 && addAfter !== i && !totalled && 'border-b-0',
                        dragId === id && 'opacity-40',
                        zone === 'inside' && '[--row:color-mix(in_oklab,var(--primary)_8%,var(--card))]',
                      )}
                    >
                      {/* Task: drag handle, tree indent, caret, title, add-subtask */}
                      <div
                        role="cell"
                        className={cn(
                          'sticky left-0 z-10 flex min-w-0 items-center gap-1 bg-(--row) pr-2 shadow-[inset_-1px_0_0_var(--border)]',
                          height,
                          zone === 'inside' && 'ring-2 ring-primary/40 ring-inset',
                        )}
                      >
                        {/* Indent guides: a faint line per level, so deep trees are easy to follow. */}
                        {Array.from({ length: depth }, (_, l) => (
                          <span key={l} aria-hidden className="absolute inset-y-0 w-px bg-border/60" style={{ left: HANDLE + l * INDENT + 11 }} />
                        ))}
                        <span className="grid shrink-0 place-items-center" style={{ width: HANDLE - 4 }} title="Drag to move">
                          {!readOnly && (
                            <DotsSixVertical
                              weight="bold"
                              className="size-3.5 cursor-grab text-muted-foreground/60 opacity-0 group-hover:opacity-100"
                            />
                          )}
                        </span>
                        <span style={{ width: depth * INDENT }} className="shrink-0" />
                        <button
                          disabled={!kids || forced || (!!keep && !kids.some((k) => keep.has(k)))}
                          onClick={() => toggle(id)}
                          aria-label={open ? 'Collapse' : 'Expand'}
                          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent disabled:hover:bg-transparent"
                        >
                          {kids ? open ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" /> : null}
                        </button>
                        <button
                          onClick={() => openTask(id)}
                          className={cn(
                            'min-w-0 truncate text-left text-sm hover:underline',
                            kids && 'font-semibold',
                            done && !kids && 'text-muted-foreground line-through',
                            context && 'font-normal text-muted-foreground',
                          )}
                        >
                          {t.title}
                        </button>
                        {isBlocked(idx, id) && (
                          <Prohibit weight="bold" className="size-3.5 shrink-0 text-warning" aria-label="Waiting on another task" />
                        )}
                        <span className="ml-auto flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                          {!readOnly && (
                            <RowAction label="Add a subtask" onClick={() => startAdding(id)}>
                              <Plus className="size-3.5" />
                            </RowAction>
                          )}
                          {kids && (
                            <RowAction label="Focus on its subtasks" onClick={() => focus(id)}>
                              <Crosshair className="size-3.5" />
                            </RowAction>
                          )}
                        </span>
                      </div>

                      {columns.slice(1).map((c, n) =>
                        c.field ? (
                          <FieldCell
                            key={c.key}
                            taskId={id}
                            field={c.field}
                            value={t.custom?.[c.field.id]}
                            total={totalText(c.field, sums.get(c.field.id)?.get(id), kids && !context)}
                            readOnly={readOnly}
                            first={n === 0}
                            height={height}
                            onSet={setValue}
                          />
                        ) : (
                          <Cell key={c.key} first={n === 0} height={height}>
                            {c.key === 'status' ? (
                              <StatusMenu id={id} />
                            ) : c.key === 'progress' ? (
                              kids && <ProgressBar done={idx.subDone.get(id)!} total={idx.subTotal.get(id)!} className="w-full" />
                            ) : c.key === 'assignee' ? (
                              t.assigneeId && (
                                <span className="flex min-w-0 items-center gap-2">
                                  <Avatar
                                    name={memberName(t.assigneeId)}
                                    picture={idx.members.get(t.assigneeId)?.picture}
                                    className="size-5 text-[9px]"
                                  />
                                  <span className="truncate text-sm">{memberName(t.assigneeId)}</span>
                                </span>
                              )
                            ) : c.key === 'priority' ? (
                              t.priority && (
                                <span className="flex items-center gap-1.5 text-xs">
                                  <PriorityIcon priority={t.priority} /> {PRIORITY_LABEL[t.priority]}
                                </span>
                              )
                            ) : c.key === 'start' ? (
                              t.start && <span className="text-xs text-muted-foreground tabular-nums">{formatDay(t.start)}</span>
                            ) : c.key === 'due' ? (
                              t.due && <DueChip due={t.due} done={done} />
                            ) : c.key === 'created' || c.key === 'updated' ? (
                              <When at={c.key === 'created' ? t.createdAt : changedAt(t)} />
                            ) : c.key === 'number' ? (
                              ref && <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">{ref}</span>
                            ) : (
                              labels.length > 0 && (
                                <span className="flex min-w-0 gap-1 overflow-hidden">
                                  {labels.map((l) => (
                                    <LabelChip key={l.id} label={l} className="shrink-0" />
                                  ))}
                                </span>
                              )
                            )}
                          </Cell>
                        ),
                      )}

                      <DropLine zone={zone} left={HANDLE + depth * INDENT} />
                    </div>
                  )
                  if (addAfter !== i || !adding) return row
                  return [
                    row,
                    <AddSubtaskRow
                      key="__add"
                      className={height}
                      indent={HANDLE + (idx.depth.get(adding)! - baseDepth + 1) * INDENT + 6}
                      parentTitle={data.tasks[adding].title}
                      onAdd={(title, fields) => createTask(adding, { ...fields, title })}
                      onClose={() => setAdding(null)}
                    />,
                  ]
                })}

                {/* Numbers that add up, for everything the table shows: stays in sight at the bottom. */}
                {totalled && (
                  <div role="row" className="sticky bottom-0 z-20 border-t bg-muted" style={grid}>
                    <div
                      role="cell"
                      className="sticky left-0 z-10 flex h-9 items-center bg-muted text-xs font-medium text-muted-foreground shadow-[inset_-1px_0_0_var(--border)]"
                      style={{ paddingLeft: HANDLE + 12 }}
                    >
                      Total
                    </div>
                    {columns.slice(1).map((c, n) => {
                      // (Nothing for a column without a single number in it.)
                      const numbers = c.field ? shownTop.flatMap((id) => sums.get(c.field!.id)?.get(id) ?? []) : []
                      return (
                        <div key={c.key} role="cell" className={cn('flex h-9 min-w-0 items-center px-3', n > 0 && 'border-l')}>
                          {numbers.length > 0 && (
                            <span className="truncate text-sm font-medium tabular-nums" aria-label={`${c.label}, total`}>
                              {numberText(c.field!, sumOf(c.field!, numbers))}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {truncated && (
            <Button variant="ghost" size="sm" className="mt-3 text-muted-foreground" onClick={() => setLimit(limit + ROWS_STEP)}>
              Show more
            </Button>
          )}
          <HiddenDoneNote count={hiddenDone} className="mt-3" />
          {!search && (
            <QuickAdd
              className="mt-2"
              single
              label={focusId ? 'Add a subtask' : 'Add a project'}
              placeholder="Title"
              submitLabel="Add"
              dates
              onAdd={(title, fields) => createTask(focusId ?? null, { ...fields, title })}
            />
          )}
        </div>
      </div>
    </>
  )
}

/** What a card and its subtasks add up to, for its cell: only for a card that has subtasks, and a number at or under it. */
function totalText(field: BoardField, total: number | undefined, parent: boolean | undefined) {
  return parent && total !== undefined ? `Σ ${numberText(field, total)}` : undefined
}

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          onClick={onClick}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A property cell (empty ones stay blank, so what's filled in stands out). The first sits right after the pinned
 * Task column, which already draws the divider.
 */
/** The day something happened (the year too, when it isn't this one); pointing at it says the time. */
function When({ at }: { at: string }) {
  return (
    <span className="truncate text-xs text-muted-foreground tabular-nums" title={formatMoment(at)}>
      {formatShortDay(at)}
    </span>
  )
}

function Cell({ children, first, height }: { children: ReactNode; first?: boolean; height: string }) {
  return (
    <div role="cell" className={cn('flex min-w-0 items-center border-border/60 px-3', height, !first && 'border-l')}>
      {children}
    </div>
  )
}
