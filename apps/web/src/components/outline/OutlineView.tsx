import {
  ArrowDown,
  ArrowUp,
  ArrowsDownUp,
  CaretDown,
  CaretRight,
  Check,
  CheckSquare,
  Crosshair,
  Minus,
  Plus,
  Prohibit,
  Square,
  X,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar, DueChip, LabelChip, PriorityIcon, ProgressBar, StatusDot } from '@/components/common/bits'
import { FieldChip } from '@/components/fields/FieldValue'
import { pointerDrag } from '@/lib/pointerDrag'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { FieldCell } from './FieldCell'
import { OutlineDisplayMenu } from './OutlineDisplayMenu'
import { PRIORITY_LABEL, type LabelDef, type Priority } from '@kanbanto/model/types'
import { Empty } from '@/components/common/Empty'
import { StatusMenu } from '@/components/common/StatusMenu'
import { QuickAdd } from '@/components/board/QuickAdd'
import { SelectionBar } from '@/components/select/SelectionBar'
import { useSelection } from '@/components/select/useSelection'
import { ViewActions } from '@/components/shell/ViewBar'
import { FoldAll } from '@/components/tree/FoldAll'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatDay, formatMoment, formatShortDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fieldIdOf, fieldKey, isFieldKey, numberText, type BoardField, type FieldType, type FieldValue } from '@kanbanto/model/fields'
import { descendantsOf, isBlocked, statusCol, type TaskIndex } from '@kanbanto/model/indexer'
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
import {
  groupCards,
  groupFields,
  groupKeep,
  groupKeyOf,
  groupLabel,
  groupName,
  TICKED,
  type CardGroup,
  type GroupKey,
} from '@kanbanto/model/outlineGroups'
import { refOf } from '@kanbanto/model/refs'
import { numberOf, subtreeSums, sumOf } from '@kanbanto/model/totals'
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

/** A heading of the grouped Outline (see the model's outlineGroups.ts) with what is laid out under it. */
interface Section extends CardGroup {
  /** The cards that are under it for their own sake: the other rows are their parents, for context. */
  own: Set<string>
  /** Those cards and the cards above them: everything that can be a row under it. */
  keep: Set<string>
  /** The rows under it (none while it is folded). */
  rows: string[]
  folded: boolean
  /** For each number field that adds up: every row's total with its subtasks, counting this heading's cards only. */
  sums: Map<string, Map<string, number>>
  /** And the heading's own total for it (absent: not a single number). */
  totals: Map<string, number>
}

/** Which headings are folded, for each column this board's Outline has been grouped by: kept on this device. */
function useFolded(boardId: string, key: GroupKey | undefined) {
  const name = `kankan:outline-folded:${boardId}`
  const [all, setAll] = useState<Record<string, string[]>>(() => {
    try {
      const kept: unknown = JSON.parse(localStorage.getItem(name) ?? '{}')
      return kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Record<string, string[]>) : {}
    } catch {
      return {}
    }
  })
  const list = key ? all[key] : undefined
  const folded = useMemo(() => new Set(Array.isArray(list) ? list : []), [list])
  const setFolded = (next: Iterable<string>) => {
    if (!key) return
    const out = { ...all, [key]: [...next] }
    setAll(out)
    try {
      localStorage.setItem(name, JSON.stringify(out))
    } catch {
      // Only a view setting.
    }
  }
  return [folded, setFolded] as const
}

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
  // The inline "add" field: for a subtask of `parent`, or (null) a new card under the heading `group`.
  const [adding, setAdding] = useState<{ parent: string | null; group?: string } | null>(null)
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
  const groupKey = groupKeyOf(cfg.group, idx.fields)
  const { rows, truncated } = useMemo(
    () => (groupKey ? { rows: [], truncated: false } : flattenTree(idx, top, expanded, limit, keep, order, !forced)),
    [idx, top, expanded, limit, keep, order, forced, groupKey],
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

  const startAdding = (parentId: string, g?: Section) => {
    expand(parentId)
    setAdding({ parent: parentId, group: g?.value })
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

  // Grouped by a column: the cards that are shown for their own sake, under a heading for each value of it. Under a
  // heading the tree is laid out as a search lays it out: those cards, the cards above them greyed, nothing folded.
  // (A parent can so be under several headings, and a card with two labels is.)
  const [folded, setFolded] = useFolded(data.board.id, groupKey)
  const sections = useMemo(() => {
    if (!groupKey) return undefined
    const scope = focusId ? descendantsOf(idx, focusId) : idx.preorder
    const cards = counted ? scope.filter((id) => counted.has(id)) : scope
    let left = limit
    let more = false
    const groups = groupCards(idx, data.labels, groupKey, cards)
      // (A list is a place, so it is there empty too; but not while looking for something.)
      .filter((g) => g.cards.length > 0 || !forced)
      .map((g): Section => {
        const own = new Set(g.cards)
        const totals = new Map<string, number>()
        for (const f of addingUp) {
          const numbers = g.cards.flatMap((id) => numberOf(idx, id, f.id) ?? [])
          if (numbers.length) totals.set(f.id, sumOf(f, numbers))
        }
        const shut = folded.has(g.value)
        if (shut || !g.cards.length) return { ...g, own, keep: own, rows: [], folded: shut, sums: new Map(), totals }
        const keep = groupKeep(idx, g.cards)
        const laid = flattenTree(idx, top, expanded, left, keep, order)
        left -= laid.rows.length
        more ||= laid.truncated
        const sums = new Map(addingUp.map((f) => [f.id, subtreeSums(idx, f, own)]))
        return { ...g, own, keep, rows: laid.rows, folded: false, sums, totals }
      })
    return { groups, truncated: more, count: cards.length }
  }, [groupKey, focusId, idx, counted, limit, data.labels, forced, addingUp, folded, top, expanded, order])
  // Ticking rows, to change several cards at once (see SelectionBar). A range (Shift) goes by the rows as they're
  // laid out; "all" is the cards that are there for their own sake, not the parents shown around them.
  const selection = useSelection()
  // (A phone has nothing to point with: its boxes show once "Select" is tapped.)
  const [selecting, setSelecting] = useState(false)
  const laid = useMemo(() => (sections ? sections.groups.flatMap((g) => g.rows) : rows), [sections, rows])
  const laidSet = useMemo(() => new Set(laid), [laid])
  const tickable = useMemo(
    () => [
      ...new Set(
        sections ? sections.groups.flatMap((g) => g.rows.filter((id) => g.own.has(id))) : matched ? rows.filter((id) => matched.has(id)) : rows,
      ),
    ],
    [sections, rows, matched],
  )
  const ticked = tickable.filter((id) => selection.has(id)).length
  const allTicked = ticked === 0 ? false : ticked === tickable.length ? true : ('mixed' as const)
  const tick = (id: string, title: string, className?: string) => (
    <Tick
      checked={selection.has(id)}
      label={`Select ${title}`}
      onToggle={(e) => selection.toggle(id, { range: e.shiftKey, order: laid })}
      className={className}
    />
  )
  const foldGroup = (value: string, shut: boolean) => setFolded([...folded].filter((v) => v !== value).concat(shut ? [value] : []))
  const foldAll = {
    disabled: !groupKey && forced,
    onExpand: () => (groupKey ? setFolded([]) : setExpanded(new Set(idx.childrenOf.keys()))),
    onCollapse: () => (groupKey ? setFolded(sections!.groups.map((g) => g.value)) : setExpanded(new Set())),
  }

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
  const plainAddAfter = adding?.parent && !groupKey ? afterSubtree(idx, rows, adding.parent) : -1
  const groupTitle = (g: Section) => <GroupTitle idx={idx} labels={data.labels} groupKey={groupKey!} value={g.value} memberName={memberName} />
  /** What a heading's cards add up to, for the number fields that do. */
  const groupTotals = (g: Section) => addingUp.flatMap((f) => (g.totals.has(f.id) ? [{ field: f, text: numberText(f, g.totals.get(f.id)!) }] : []))

  /** A heading of the phone's list: the value, how many cards, what they add up to. */
  const listHeading = (g: Section) => (
    <li key={`g:${g.value}`} className="bg-muted">
      <button
        onClick={() => foldGroup(g.value, !g.folded)}
        aria-expanded={!g.folded}
        className="flex min-h-10 w-full items-center gap-2 py-1.5 pr-3 pl-2 text-left"
      >
        {g.folded ? (
          <CaretRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CaretDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {groupTitle(g)}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{g.cards.length.toLocaleString()}</span>
        <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-x-2.5 text-xs text-muted-foreground tabular-nums">
          {groupTotals(g).map((x) => (
            <span key={x.field.id}>
              {x.field.name} {x.text}
            </span>
          ))}
        </span>
      </button>
    </li>
  )

  /** A heading of the table: the value and how many cards, then each column's total where numbers add up. */
  const tableHeading = (g: Section, last: boolean) => (
    <div key={`g:${g.value}`} role="row" data-group={g.value} style={grid} className={cn('group border-b bg-muted', last && 'border-b-0')}>
      <div role="cell" className="sticky left-0 z-10 flex h-9 min-w-0 items-center gap-2 bg-muted pr-2 pl-1 shadow-[inset_-1px_0_0_var(--border)]">
        <button
          onClick={() => foldGroup(g.value, !g.folded)}
          aria-expanded={!g.folded}
          aria-label={g.folded ? 'Show its tasks' : 'Hide its tasks'}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
        >
          {g.folded ? <CaretRight className="size-3.5" /> : <CaretDown className="size-3.5" />}
        </button>
        {groupTitle(g)}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-label={`${g.cards.length} tasks`}>
          {g.cards.length.toLocaleString()}
        </span>
        {!readOnly && !search && (
          <span className="ml-auto flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <RowAction
              label="Add a task here"
              onClick={() => {
                if (g.folded) foldGroup(g.value, false)
                setAdding({ parent: null, group: g.value })
              }}
            >
              <Plus className="size-3.5" />
            </RowAction>
          </span>
        )}
      </div>
      {columns.slice(1).map((c) => (
        <div key={c.key} role="cell" className="flex h-9 min-w-0 items-center px-3">
          {c.field && g.totals.has(c.field.id) && (
            <span className="truncate text-sm font-medium tabular-nums" aria-label={`${c.label}, total`}>
              {numberText(c.field, g.totals.get(c.field.id)!)}
            </span>
          )}
        </div>
      ))}
    </div>
  )

  /** A row of the phone's list. Under a heading (`g`): there for itself, or greyed as the parent of a card that is. */
  const listRow = (id: string, g?: Section) => {
    const t = data.tasks[id]
    const ref = refOf(data.board, t)
    const kids = idx.childrenOf.get(id)
    const open = !!g || forced || expanded.has(id)
    const depth = idx.depth.get(id)! - baseDepth
    const done = idx.category.get(id) === 'done'
    const col = statusCol(idx, id)
    const context = g ? !g.own.has(id) : matched && !matched.has(id)
    // (Under a heading a card can be there twice, and its place isn't one in the tree: nothing is dragged.)
    const zone = g ? undefined : zoneOf(id)
    return (
      <li
        key={g ? `${g.value}/${id}` : id}
        {...(!g && { ...dragProps(id), ...dropProps(id) })}
        className={cn(
          'relative flex items-start gap-1 py-2 pr-3',
          !g && 'drag-handle',
          !g && !depth && kids && 'bg-muted/40',
          selection.has(id) && 'bg-primary/8',
          dragId === id && 'opacity-40',
          zone === 'inside' && 'bg-primary/8',
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        {!readOnly && (selecting || selection.size > 0) && tick(id, t.title, 'mt-1 mr-1 ml-1.5 size-5')}
        <button
          disabled={!kids || !!g || forced || (!!keep && !kids.some((k) => keep.has(k)))}
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
              data.fields.map((f) => f.front && t.custom![f.id] !== undefined && <FieldChip key={f.id} field={f} value={t.custom![f.id]} />)}
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
  }

  /** A row of the table. `at`: where it is among the rows it's laid out with, for the last line and the inline add row. */
  const tableRow = (id: string, i: number, at: { last: boolean; addAfter: number; g?: Section }) => {
    const g = at.g
    const t = data.tasks[id]
    const ref = refOf(data.board, t)
    const kids = idx.childrenOf.get(id)
    const open = !!g || forced || expanded.has(id)
    const depth = idx.depth.get(id)! - baseDepth
    const done = idx.category.get(id) === 'done'
    // Shown only because a subtask matches, or (under a heading) is one of the heading's cards.
    const context = g ? !g.own.has(id) : matched && !matched.has(id)
    const labels = t.labels.map((l) => labelById.get(l)).filter((l) => !!l)
    const zone = g ? undefined : zoneOf(id)
    // Hover is a solid color (not see-through) so the pinned Task cell can match it.
    const row = (
      <div
        key={g ? `${g.value}/${id}` : id}
        role="row"
        {...(!g && { ...dragProps(id), ...dropProps(id) })}
        style={grid}
        className={cn(
          // The row's color is a variable, so the pinned Task cell can match it (hover included).
          'group relative border-b bg-(--row) [--row:var(--card)] hover:[--row:color-mix(in_oklab,var(--accent)_45%,var(--card))]',
          !g && 'drag-handle',
          // (Under a heading, the heading is the band: a tinted project under it would read as another one.)
          !g && !depth && kids && '[--row:color-mix(in_oklab,var(--muted)_55%,var(--card))]',
          selection.has(id) &&
            '[--row:color-mix(in_oklab,var(--primary)_10%,var(--card))] hover:[--row:color-mix(in_oklab,var(--primary)_14%,var(--card))]',
          at.last && at.addAfter !== i && !totalled && 'border-b-0',
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
          {/* The row's tick box, there when the row is pointed at and for every row once one is ticked. (A row is
              dragged from anywhere on it: it needs no handle.) */}
          <span className="grid shrink-0 place-items-center" style={{ width: HANDLE - 4 }}>
            {!readOnly &&
              tick(
                id,
                t.title,
                selection.size > 0 ? undefined : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch-only:opacity-100',
              )}
          </span>
          <span style={{ width: depth * INDENT }} className="shrink-0" />
          <button
            disabled={!kids || !!g || forced || (!!keep && !kids.some((k) => keep.has(k)))}
            onClick={() => toggle(id)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent disabled:hover:bg-transparent"
          >
            {/* (Under a heading: no arrow on a card whose subtasks are all under other headings.) */}
            {(g ? kids?.some((k) => g.keep.has(k)) : kids) ? open ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" /> : null}
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
          {isBlocked(idx, id) && <Prohibit weight="bold" className="size-3.5 shrink-0 text-warning" aria-label="Waiting on another task" />}
          <span className="ml-auto flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {!readOnly && (
              <RowAction label="Add a subtask" onClick={() => startAdding(id, g)}>
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
              total={totalText(c.field, (g?.sums ?? sums).get(c.field.id)?.get(id), kids && !context)}
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
                    <Avatar name={memberName(t.assigneeId)} picture={idx.members.get(t.assigneeId)?.picture} className="size-5 text-[9px]" />
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
    const parent = adding?.parent
    if (at.addAfter !== i || !parent) return row
    return [
      row,
      // (Added under a heading, a subtask starts with the heading's value, so it shows where it was typed.)
      <AddSubtaskRow
        key={g ? `add:${g.value}` : '__add'}
        className={height}
        indent={HANDLE + (idx.depth.get(parent)! - baseDepth + 1) * INDENT + 6}
        parentTitle={data.tasks[parent].title}
        onAdd={(title, fields) => createTask(parent, { ...fields, ...(g && groupFields(idx, groupKey!, g.value)), title })}
        onClose={() => setAdding(null)}
      />,
    ]
  }

  return (
    <>
      <ViewActions>
        <PresetMenu />
        <FilterMenu />
        <OutlineDisplayMenu />
      </ViewActions>

      <div className="h-full overflow-auto">
        {/* (Room under the last row for the bar of the selection, which floats there.) */}
        <div className={cn('px-3 py-4 sm:px-6', selection.size > 0 && 'pb-20')}>
          {/* A phone's list has no "Task" heading to hold them. */}
          <div className="mb-1 flex items-center justify-end md:hidden">
            {!readOnly && (
              <button
                onClick={() => {
                  if (selecting || selection.size) selection.clear()
                  setSelecting(!(selecting || selection.size > 0))
                }}
                className="mr-auto h-7 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {selecting || selection.size > 0 ? 'Cancel' : 'Select'}
              </button>
            )}
            <FoldAll {...foldAll} />
          </div>
          {(cfg.sort || matched || groupKey) && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {groupKey && (
                <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-card pr-1 pl-3 text-xs">
                  <span className="text-muted-foreground">Grouped by</span>
                  <span className="font-medium">{groupLabel(groupKey, idx.fields)}</span>
                  <button
                    aria-label="Stop grouping"
                    onClick={() => setPrefs({ type: 'setOutline', config: { ...cfg, group: undefined } })}
                    className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              )}
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
              {(cfg.sort || groupKey) && !readOnly && (
                <span className="px-1 text-xs text-muted-foreground">
                  · Clear the {groupKey ? (cfg.sort ? 'grouping and the sort' : 'grouping') : 'sort'} to reorder by dragging
                </span>
              )}
            </div>
          )}

          {(sections ? sections.count === 0 : rows.length === 0) ? (
            <Empty>{search || filtering ? 'No tasks match.' : hiddenDone ? 'Everything here is done.' : 'No tasks here yet.'}</Empty>
          ) : narrow ? (
            <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Tasks">
              {sections ? sections.groups.flatMap((g) => [listHeading(g), ...g.rows.map((id) => listRow(id, g))]) : rows.map((id) => listRow(id))}
            </ul>
          ) : (
            // One scroll area (the page) for both directions, so the header and task column can both stay pinned.
            // overflow-clip rounds the corners without becoming a scroll container.
            <div className="w-full overflow-clip rounded-xl border bg-card" style={{ minWidth }}>
              <div role="table" aria-label="Tasks">
                {/* Header row, pinned while you scroll. Click a column to sort by it. */}
                <div ref={headerRow} role="row" className="group/head sticky top-0 z-20 border-b bg-muted" style={grid}>
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
                        {/* Ticks every card that is shown (what a search or a filter found), or unticks them. */}
                        {i === 0 && !readOnly && tickable.length > 0 && (
                          <span className="absolute inset-y-0 left-0 grid place-items-center" style={{ width: HANDLE }}>
                            <Tick
                              checked={allTicked}
                              label="Select all the tasks shown"
                              onToggle={() => (allTicked === true ? selection.remove(tickable) : selection.add(tickable))}
                              className={
                                selection.size > 0
                                  ? undefined
                                  : 'opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100 touch-only:opacity-100'
                              }
                            />
                          </span>
                        )}
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
                        {i === 0 && <FoldAll className="pr-1.5" {...foldAll} />}
                      </div>
                    )
                  })}
                </div>

                {sections
                  ? sections.groups.flatMap((g, n) => {
                      const lastGroup = n === sections.groups.length - 1
                      const addTop = adding?.group === g.value && adding.parent === null
                      const addAfter = adding?.parent && adding.group === g.value ? afterSubtree(idx, g.rows, adding.parent) : -1
                      return [
                        tableHeading(g, lastGroup && !g.rows.length && !addTop && !totalled),
                        ...g.rows.map((id, i) => tableRow(id, i, { g, addAfter, last: lastGroup && i === g.rows.length - 1 && !addTop })),
                        addTop && (
                          <AddSubtaskRow
                            key={`add:${g.value}`}
                            className={height}
                            indent={HANDLE + 6}
                            parentTitle=""
                            prompt={`New task under “${groupName(idx, data.labels, groupKey!, g.value)}”`}
                            onAdd={(title, fields) => createTask(focusId ?? null, { ...fields, ...groupFields(idx, groupKey!, g.value), title })}
                            onClose={() => setAdding(null)}
                          />
                        ),
                      ]
                    })
                  : rows.map((id, i) => tableRow(id, i, { addAfter: plainAddAfter, last: i === rows.length - 1 }))}

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

          {(sections ? sections.truncated : truncated) && (
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
      {!readOnly && <SelectionBar selection={selection} shown={laidSet} className={totalled && !narrow ? 'bottom-12' : undefined} />}
    </>
  )
}

/**
 * A tick box of the table: a row's, or the Task heading's for all of them (a dash: some are ticked). A plain button
 * that looks like the app's checkbox, since a table has thousands. It keeps its press to itself: the row under it
 * is dragged by a press, and Shift with a click would select text.
 */
function Tick({
  checked,
  label,
  onToggle,
  className,
}: {
  checked: boolean | 'mixed'
  label: string
  onToggle: (e: React.MouseEvent) => void
  className?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(e)
      }}
      className={cn(
        'grid size-4 shrink-0 place-content-center rounded-[4px] border border-input bg-card shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        checked && 'border-primary bg-primary text-primary-foreground',
        className,
      )}
    >
      {checked === true ? <Check weight="bold" className="size-3" /> : checked === 'mixed' ? <Minus weight="bold" className="size-3" /> : null}
    </button>
  )
}

/** What a card and its subtasks add up to, for its cell: only for a card that has subtasks, and a number at or under it. */
function totalText(field: BoardField, total: number | undefined, parent: boolean | undefined) {
  return parent && total !== undefined ? `Σ ${numberText(field, total)}` : undefined
}

/** A heading's value drawn as the thing it is: a list with its dot, a person with their picture, a label as its chip. */
function GroupTitle({
  idx,
  labels,
  groupKey,
  value,
  memberName,
}: {
  idx: TaskIndex
  labels: readonly LabelDef[]
  groupKey: GroupKey
  value: string
  memberName: (id: string) => string
}) {
  const name = groupName(idx, labels, groupKey, value)
  const field = isFieldKey(groupKey) ? idx.fields.get(fieldIdOf(groupKey)) : undefined
  const text = <span className={cn('truncate text-sm font-medium', !value && 'text-muted-foreground')}>{name}</span>
  if (!value) return text
  if (groupKey === 'status') {
    const col = idx.colById.get(value)
    return (
      <span className="flex min-w-0 items-center gap-2">
        {col && <StatusDot category={col.category} color={col.color} />}
        {text}
      </span>
    )
  }
  if (groupKey === 'assignee' || field?.type === 'person')
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Avatar name={memberName(value)} picture={idx.members.get(value)?.picture} className="size-5 text-[9px]" />
        {text}
      </span>
    )
  if (groupKey === 'priority')
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <PriorityIcon priority={value as Priority} />
        {text}
      </span>
    )
  if (groupKey === 'labels') {
    const label = labels.find((l) => l.id === value)
    return label ? <LabelChip label={label} className="min-w-0" /> : text
  }
  if (field?.type === 'choice') {
    const option = field.options?.find((o) => o.id === value)
    return option ? <LabelChip label={option} className="min-w-0" /> : text
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {value === TICKED ? (
        <CheckSquare weight="fill" className="size-4 shrink-0 text-status-done" />
      ) : (
        <Square className="size-4 shrink-0 text-muted-foreground" />
      )}
      {text}
    </span>
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
