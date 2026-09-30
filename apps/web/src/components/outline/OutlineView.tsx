import {
  ArrowDown,
  ArrowUp,
  ArrowsDownUp,
  ArrowsInSimple,
  ArrowsOutSimple,
  CaretDown,
  CaretRight,
  Crosshair,
  DotsSixVertical,
  Plus,
  Prohibit,
  X,
} from '@phosphor-icons/react'
import { useMemo, useState, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar, DueChip, LabelChip, PriorityIcon, ProgressBar, StatusDot } from '@/components/common/bits'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { OutlineDisplayMenu } from './OutlineDisplayMenu'
import { PRIORITY_LABEL } from '@kanbanto/model/types'
import { Empty } from '@/components/common/Empty'
import { StatusMenu } from '@/components/common/StatusMenu'
import { QuickAdd } from '@/components/board/QuickAdd'
import { BarIconButton, ViewActions } from '@/components/shell/ViewBar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isBlocked, statusCol } from '@kanbanto/model/indexer'
import { sortComparator, type OutlineColumn, type Sort, type SortKey } from '@kanbanto/model/table'
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
 * scanning. Property columns can be switched off in Display.
 */
const COLUMNS: { key: SortKey; label: string; width: number }[] = [
  { key: 'title', label: 'Task', width: 18 },
  { key: 'status', label: 'Status', width: 8.5 },
  { key: 'progress', label: 'Progress', width: 9.5 },
  { key: 'assignee', label: 'Assignee', width: 9 },
  { key: 'priority', label: 'Priority', width: 6.5 },
  { key: 'start', label: 'Start', width: 6.5 },
  { key: 'due', label: 'Due', width: 6.5 },
  { key: 'labels', label: 'Labels', width: 11 },
]
const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])) as Record<SortKey, string>
const INDENT = 20
/** Width of the drag handle before the indent. */
const HANDLE = 28

/**
 * Everything as one nested table: the task tree on the left, its properties in columns.
 * Sort by clicking a header, filter from "Filter", add subtasks inline, and drag rows to reorder or move them.
 */
export function OutlineView({ search }: { search: string }) {
  const { data, prefs, setPrefs, idx, openTask, createTask, focus, memberName, readOnly } = useBoard()
  const cfg = prefs.outline
  const setSort = (sort?: Sort) => setPrefs({ type: 'setOutline', config: { ...cfg, sort } })

  const [expanded, setExpanded] = useState(() => defaultExpanded(idx))
  const [limit, setLimit] = useState(ROWS_STEP)
  const [adding, setAdding] = useState<string | null>(null)
  const labelById = useMemo(() => new Map(data.labels.map((l) => [l.id, l])), [data.labels])

  const focusId = prefs.focusId && prefs.focusId in data.tasks ? prefs.focusId : undefined
  const { top, baseDepth } = treeTop(idx, focusId)

  // Search and filters show the matching tasks plus their parents (muted) for context.
  const { keep, matched, filtering, hiddenDone } = useTreeFilter(search)

  const order = useMemo(() => {
    if (!cfg.sort) return undefined
    const cmp = sortComparator(idx, cfg.sort, labelById)
    return (ids: string[]) => [...ids].sort(cmp)
  }, [idx, cfg.sort, labelById])

  const { rows, truncated } = flattenTree(idx, top, expanded, limit, keep, order)

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
  const hidden = new Set(cfg.hidden ?? [])
  const columns = COLUMNS.filter((c) => c.key === 'title' || !hidden.has(c.key as OutlineColumn))
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
      <ViewActions lead>
        <BarIconButton label="Expand all" onClick={() => setExpanded(new Set(idx.childrenOf.keys()))}>
          <ArrowsOutSimple />
        </BarIconButton>
        <BarIconButton label="Collapse all" onClick={() => setExpanded(new Set())}>
          <ArrowsInSimple />
        </BarIconButton>
      </ViewActions>

      <div className="h-full overflow-auto">
        <div className="px-3 py-4 sm:px-6">
          {(cfg.sort || matched) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {cfg.sort && (
                <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-3 text-xs">
                  <span className="text-muted-foreground">Sorted by</span>
                  <span className="font-medium">
                    {COLUMN_LABEL[cfg.sort.key].toLowerCase()} {cfg.sort.dir === 'asc' ? '↑' : '↓'}
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
                const kids = idx.childrenOf.get(id)
                const open = !!keep || expanded.has(id)
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
                      disabled={!kids || !!keep}
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
                            <Avatar name={memberName(t.assigneeId)} className="size-4 text-[8px]" /> {memberName(t.assigneeId)}
                          </span>
                        )}
                        {t.due && <DueChip due={t.due} done={done} />}
                        {isBlocked(idx, id) && <Prohibit weight="bold" className="size-3.5 text-warning" aria-label="Waiting on another task" />}
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
                <div role="row" className="sticky top-0 z-20 border-b bg-muted" style={grid}>
                  {columns.map((c, i) => {
                    const on = cfg.sort?.key === c.key ? cfg.sort.dir : undefined
                    return (
                      <div
                        key={c.key}
                        role="columnheader"
                        aria-sort={on === 'asc' ? 'ascending' : on === 'desc' ? 'descending' : 'none'}
                        className={cn(
                          'flex h-9 items-center',
                          // The pinned Task column draws its own divider, so columns sliding under it stay separate.
                          i === 0 && 'sticky left-0 z-10 bg-muted shadow-[inset_-1px_0_0_var(--border)]',
                          i > 1 && 'border-l',
                        )}
                        style={i === 0 ? { paddingLeft: HANDLE } : undefined}
                      >
                        <button
                          onClick={() => setSort(!on ? { key: c.key, dir: 'asc' } : on === 'asc' ? { key: c.key, dir: 'desc' } : undefined)}
                          title={!on ? `Sort by ${c.label.toLowerCase()}` : on === 'asc' ? 'Sort the other way' : 'Stop sorting'}
                          className={cn(
                            'group/sort flex h-full w-full items-center gap-1 px-3 text-left text-xs font-medium hover:text-foreground',
                            on ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {c.label}
                          {on === 'asc' ? (
                            <ArrowUp weight="bold" className="size-3" />
                          ) : on === 'desc' ? (
                            <ArrowDown weight="bold" className="size-3" />
                          ) : (
                            <ArrowsDownUp className="size-3 opacity-0 group-hover/sort:opacity-60" />
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>

                {rows.map((id, i) => {
                  const t = data.tasks[id]
                  const kids = idx.childrenOf.get(id)
                  const open = !!keep || expanded.has(id)
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
                        i === rows.length - 1 && addAfter !== i && 'border-b-0',
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
                          disabled={!kids || !!keep}
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

                      {columns.slice(1).map((c, n) => (
                        <Cell key={c.key} first={n === 0} height={height}>
                          {c.key === 'status' ? (
                            <StatusMenu id={id} />
                          ) : c.key === 'progress' ? (
                            kids && <ProgressBar done={idx.subDone.get(id)!} total={idx.subTotal.get(id)!} className="w-full" />
                          ) : c.key === 'assignee' ? (
                            t.assigneeId && (
                              <span className="flex min-w-0 items-center gap-2">
                                <Avatar name={memberName(t.assigneeId)} className="size-5 text-[9px]" />
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
                      ))}

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
function Cell({ children, first, height }: { children: ReactNode; first?: boolean; height: string }) {
  return (
    <div role="cell" className={cn('flex min-w-0 items-center border-border/60 px-3', height, !first && 'border-l')}>
      {children}
    </div>
  )
}
