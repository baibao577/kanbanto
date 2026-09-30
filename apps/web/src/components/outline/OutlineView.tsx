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
import { Avatar, DueChip, LabelChip, PriorityIcon, ProgressBar } from '@/components/common/bits'
import { PRIORITY_LABEL } from '@kanbanto/model/types'
import { Empty } from '@/components/common/Empty'
import { StatusMenu } from '@/components/common/StatusMenu'
import { QuickAdd } from '@/components/board/QuickAdd'
import { ViewActions } from '@/components/shell/ViewBar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isBlocked } from '@kanbanto/model/indexer'
import { sortComparator, type Sort, type SortKey } from '@kanbanto/model/table'
import { afterSubtree, defaultExpanded, flattenTree, treeTop } from '@kanbanto/model/tree'
import { FilterMenu } from '@/components/shell/FilterMenu'
import { AddSubtaskRow, DropLine } from '@/components/tree/rows'
import { useRowDrag } from '@/components/tree/useRowDrag'
import { useTreeFilter } from '@/components/tree/useTreeFilter'

const ROWS_STEP = 500

/** The table's columns. The task column stretches; the rest are fixed so values line up for scanning. */
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'title', label: 'Task' },
  { key: 'status', label: 'Status' },
  { key: 'progress', label: 'Progress' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
  { key: 'start', label: 'Start' },
  { key: 'due', label: 'Due' },
  { key: 'labels', label: 'Labels' },
]
// Fixed columns add up to 57.5rem; with the 18rem minimum for Task, the table never gets narrower than 75.5rem.
const GRID = 'grid grid-cols-[minmax(18rem,1fr)_8.5rem_9.5rem_9rem_6.5rem_6.5rem_6.5rem_11rem]'
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
  const { keep, matched, filtering } = useTreeFilter(search)

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

  // Where the inline "add a subtask" field goes: right after the parent's last visible descendant.
  const addAfter = adding ? afterSubtree(idx, rows, adding) : -1

  return (
    <>
      <ViewActions>
        <FilterMenu />
        <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => setExpanded(new Set(idx.childrenOf.keys()))}>
          <ArrowsOutSimple /> Expand all
        </Button>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => setExpanded(new Set())}>
          <ArrowsInSimple /> Collapse all
        </Button>
      </ViewActions>

      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-7xl px-4 py-4">
          {(cfg.sort || matched) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {cfg.sort && (
                <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-3 text-xs">
                  <span className="text-muted-foreground">Sorted by</span>
                  <span className="font-medium">
                    {COLUMNS.find((c) => c.key === cfg.sort!.key)!.label.toLowerCase()} {cfg.sort.dir === 'asc' ? '↑' : '↓'}
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
            <Empty>{search || filtering ? 'No tasks match.' : 'No tasks here yet.'}</Empty>
          ) : (
            // One scroll area (the page) for both directions, so the header and task column can both stay pinned.
            // overflow-clip rounds the corners without becoming a scroll container.
            <div className="w-full min-w-[75.5rem] overflow-clip rounded-xl border bg-card">
              <div role="table" aria-label="Tasks">
                {/* Header row, pinned while you scroll. Click a column to sort by it. */}
                <div role="row" className={cn(GRID, 'sticky top-0 z-20 border-b bg-muted')}>
                  {COLUMNS.map((c, i) => {
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
                      className={cn(
                        GRID,
                        'group drag-handle relative border-b hover:bg-[color-mix(in_oklab,var(--accent)_45%,var(--card))]',
                        i === rows.length - 1 && addAfter !== i && 'border-b-0',
                        dragId === id && 'opacity-40',
                        zone === 'inside' && 'bg-primary/8',
                      )}
                    >
                      {/* Task: drag handle, tree indent, caret, title, add-subtask */}
                      <div
                        role="cell"
                        className={cn(
                          'sticky left-0 z-10 flex h-10 min-w-0 items-center gap-1 bg-card pr-2 shadow-[inset_-1px_0_0_var(--border)] group-hover:bg-[color-mix(in_oklab,var(--accent)_45%,var(--card))]',
                          zone === 'inside' && 'bg-[color-mix(in_oklab,var(--primary)_8%,var(--card))] ring-2 ring-primary/40 ring-inset',
                        )}
                      >
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

                      <Cell first>
                        <StatusMenu id={id} />
                      </Cell>
                      <Cell>{kids ? <ProgressBar done={idx.subDone.get(id)!} total={idx.subTotal.get(id)!} className="w-full" /> : <Blank />}</Cell>
                      <Cell>
                        {t.assigneeId ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <Avatar name={memberName(t.assigneeId)} className="size-5 text-[9px]" />
                            <span className="truncate text-sm">{memberName(t.assigneeId)}</span>
                          </span>
                        ) : (
                          <Blank />
                        )}
                      </Cell>
                      <Cell>
                        {t.priority ? (
                          <span className="flex items-center gap-1.5 text-xs">
                            <PriorityIcon priority={t.priority} /> {PRIORITY_LABEL[t.priority]}
                          </span>
                        ) : (
                          <Blank />
                        )}
                      </Cell>
                      <Cell>{t.start ? <span className="text-xs text-muted-foreground tabular-nums">{formatDay(t.start)}</span> : <Blank />}</Cell>
                      <Cell>{t.due ? <DueChip due={t.due} done={done} /> : <Blank />}</Cell>
                      <Cell>
                        {labels.length ? (
                          <span className="flex min-w-0 gap-1 overflow-hidden">
                            {labels.map((l) => (
                              <LabelChip key={l.id} label={l} className="shrink-0" />
                            ))}
                          </span>
                        ) : (
                          <Blank />
                        )}
                      </Cell>

                      <DropLine zone={zone} left={HANDLE + depth * INDENT} />
                    </div>
                  )
                  if (addAfter !== i || !adding) return row
                  return [
                    row,
                    <AddSubtaskRow
                      key="__add"
                      className="h-10"
                      indent={HANDLE + (idx.depth.get(adding)! - baseDepth + 1) * INDENT + 6}
                      parentTitle={data.tasks[adding].title}
                      onAdd={(title) => createTask(adding, { title })}
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
          {!search && (
            <QuickAdd
              className="mt-2"
              single
              label={focusId ? 'Add a subtask' : 'Add a project'}
              placeholder="Title"
              submitLabel="Add"
              onAdd={(title) => createTask(focusId ?? null, { title })}
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

/** A property cell. The first one sits right after the pinned Task column, which already draws the divider. */
function Cell({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <div role="cell" className={cn('flex h-10 min-w-0 items-center px-3', !first && 'border-l')}>
      {children}
    </div>
  )
}

/** An empty cell: a faint dash keeps the column readable. */
function Blank() {
  return <span className="text-muted-foreground/40">–</span>
}
