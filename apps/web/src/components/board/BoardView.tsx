import { ArrowsInSimple, ArrowsOutSimple, CaretDown, CaretRight, Crosshair, Eye, EyeSlash } from '@phosphor-icons/react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { useBoard } from '@/app/board-context'
import { Avatar, ProgressBar, StatusDot, StatusPill } from '@/components/common/bits'
import { Empty } from '@/components/common/Empty'
import { DisplayMenu } from '@/components/shell/DisplayMenu'
import { FilterMenu } from '@/components/shell/FilterMenu'
import { ViewActions } from '@/components/shell/ViewBar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { pointerDrag } from '@/lib/pointerDrag'
import { cn } from '@/lib/utils'
import { tone } from '@kanbanto/model/colors'
import { ancestorsOf, statusCol } from '@kanbanto/model/indexer'
import { filterCount, matchesFilter } from '@kanbanto/model/table'
import type { StatusColumn } from '@kanbanto/model/types'
import { buildView, cellKey, groupCell, groupsSubtasks, NO_ROW, UNASSIGNED, type Lane } from '@kanbanto/model/view'
import { cardIndexAt, dragging, itemIndexAt, listIndexAt, type GroupDrag } from './dnd'
import { BLOCKED, blockReason as blockReasonIn, dropCommand, dropGroupCommand, groupOf as groupOfIn, newCardIn, type DropContext } from './dropRules'
import { GroupHeader } from './GroupHeader'
import { ListHeader } from './ListHeader'
import { QuickAdd } from './QuickAdd'
import { TaskCard } from './TaskCard'

// Render caps keep the page light however many tasks there are.
const CARDS_STEP = 100
const ROWS_STEP = 40
const COLS_STEP = 30

/**
 * Where a dragged card (or a parent's group, `moving: 'group'`) would land: a cell and a position in it.
 * With grouped subtasks, `index` is a position among the list's items (cards without a parent header, and groups),
 * except when the card lands inside its parent's `group`: then it's a position there. `newGroup` is the parent whose
 * group the card starts at `index`. `blocked` says why it can't go there.
 */
type CardDrop = {
  row: string
  col: string
  cell: string
  index: number
  blocked?: string
  group?: string
  newGroup?: string
  moving?: 'group'
}
const sameDrop = (a: CardDrop | null, b: CardDrop) =>
  !!a &&
  a.cell === b.cell &&
  a.index === b.index &&
  a.blocked === b.blocked &&
  a.group === b.group &&
  a.newGroup === b.newGroup &&
  a.moving === b.moving

/** A list's own color, as a light tint over the list background. */
const laneTint = (col?: StatusColumn) =>
  col?.color ? { backgroundColor: `color-mix(in oklab, ${tone(col.color)} var(--tint-lane), var(--lane))` } : undefined

export function BoardView({ search }: { search: string }) {
  const { prefs } = useBoard()
  return (
    <>
      <ViewActions>
        <FilterMenu />
        <DisplayMenu />
      </ViewActions>
      {/* Changing display settings starts the board fresh (paging, drag state); the Display menu stays open. */}
      <Board key={JSON.stringify(prefs.display.board)} search={search} />
    </>
  )
}

function Board({ search }: { search: string }) {
  const { data, prefs, setPrefs, idx, run, openTask, createTask, focus, readOnly, counts, moveToBoard } = useBoard()
  const config = prefs.display.board
  // Filters (shared by every tab) narrow the cards, like search.
  const filter = prefs.filter
  const view = useMemo(() => {
    const keep = filterCount(filter) ? (id: string) => matchesFilter(idx, id, filter) : undefined
    return buildView(idx, config, { focusId: prefs.focusId, search, keep })
  }, [idx, config, prefs.focusId, search, filter])
  const labelById = useMemo(() => new Map(data.labels.map((l) => [l.id, l])), [data.labels])

  const [rowLimit, setRowLimit] = useState(ROWS_STEP)
  const [colLimit, setColLimit] = useState(COLS_STEP)
  const [cellLimits, setCellLimits] = useState<Record<string, number>>({})
  const [editingList, setEditingList] = useState<string | null>(null)
  const [cardDrop, setCardDrop] = useState<CardDrop | null>(null)
  const [listDrag, setListDrag] = useState<{ id: string; height: number } | null>(null)
  const [listDrop, setListDrop] = useState<number | null>(null)

  const statusLists = config.columns === 'status'
  const grouping = groupsSubtasks(config)
  // With subtasks grouped under headers, the header already says where a card belongs.
  const cardConfig = useMemo(
    () => (grouping ? { ...config, parentDisplay: config.parentDisplay.filter((p) => p !== 'label') } : config),
    [config, grouping],
  )
  const boardRef = useRef<HTMLDivElement>(null)
  const rules: DropContext = useMemo(() => ({ data, idx, config, cells: view.cells }), [data, idx, config, view.cells])
  const groupOf = (id: string, row: string) => groupOfIn(rules, id, row)
  const grouped = config.rows !== 'none'
  const columns = view.columns.slice(0, colLimit)
  const nestedRows = config.rows === 'directParent'

  // Collapsed rows. With a row per parent task, collapsing a row also tucks away the rows nested under it.
  const collapsed = useMemo(() => new Set(prefs.collapsedRows), [prefs.collapsedRows])
  const rowAncestors = (r: Lane) => (nestedRows && r.taskId ? ancestorsOf(data.tasks, r.taskId) : [])
  const shownRows = useMemo(() => {
    if (!collapsed.size || !nestedRows) return view.rows
    return view.rows.filter((r) => !r.taskId || !ancestorsOf(data.tasks, r.taskId).some((a) => collapsed.has(a)))
  }, [view.rows, collapsed, nestedRows, data.tasks])
  const rows = shownRows.slice(0, rowLimit)
  const rowIndex = useMemo(() => new Map(shownRows.map((r, i) => [r.key, i])), [shownRows])
  /** Cards in a row, plus (for nested rows) the rows tucked under it. */
  const rowCount = (r: Lane) => {
    let n = 0
    for (const other of view.rows) {
      if (other.key !== r.key && !(r.taskId && rowAncestors(other).includes(r.taskId))) continue
      for (const c of view.columns) n += view.cells.get(cellKey(other.key, c.key))?.length ?? 0
    }
    return n
  }
  const hiddenLists = statusLists ? data.columns.filter((c) => config.hiddenColumns?.includes(c.id)) : []

  const colCount = (col: string) => view.rows.reduce((n, r) => n + (view.cells.get(cellKey(r.key, col))?.length ?? 0), 0)
  const cellIds = (k: string) => (view.cells.get(k) ?? []).slice(0, cellLimits[k] ?? CARDS_STEP)

  const blockReason = (id: string, row: string, col: string) => blockReasonIn(rules, id, row, col)

  /** A parent's header dropped at position `at` of a list: its subtasks from the list it came from move there. */
  const dropGroup = (g: GroupDrag, row: string, col: string, at: number) => {
    const cmd = dropGroupCommand(rules, g, row, col, at)
    if (cmd === BLOCKED.project)
      toast('Cards can’t be dragged between projects here', {
        description: 'Open the parent to change where it belongs, or show a row for each parent task instead.',
      })
    else if (cmd) run(cmd)
  }

  /** A card dropped in cell (row, col) at position `at` (see dropRules.ts for what that means). */
  const drop = (id: string, row: string, col: string, at: number) => {
    const blocked = blockReason(id, row, col)
    if (blocked === BLOCKED.derived)
      toast(`“${data.tasks[id].title}” follows its subtasks`, {
        description: 'Move its subtasks instead. To set parent status yourself, change it in Board settings.',
      })
    else if (blocked === BLOCKED.project)
      toast('Cards can’t be dragged between projects here', {
        description: 'Open the card to change its parent, or show a row for each parent task instead.',
      })
    else if (blocked === BLOCKED.cycle) toast.error('A task can’t go inside one of its own subtasks.')
    else {
      const cmd = dropCommand(rules, id, row, col, at)
      if (cmd) run(cmd)
    }
  }

  /** A card moved from its menu: to another column (at the bottom), or to the top or bottom of its own. */
  const moveFrom = (row: string, col: string) => ({
    lists: columns,
    col,
    toBoard: moveToBoard,
    archive: (id: string) => run({ type: 'task.archive', id }),
    to: (id: string, where: { col: string } | 'top' | 'bottom') => {
      const to = typeof where === 'object' ? where.col : col
      drop(id, row, to, where === 'top' ? 0 : (view.cells.get(cellKey(row, to))?.length ?? 0))
    },
  })

  /** New card typed into a cell: it takes that cell's status / parent / person. */
  const addIn = (row: string, col: string) => (title: string) => {
    const { parentId, fields, rankAfter } = newCardIn(rules, prefs.focusId, row, col, title)
    createTask(parentId, fields, { rankAfter })
  }

  const jumpToRow = (key: string) => {
    // Open up the row (and any collapsed rows above it) first.
    const lane = view.rows.find((r) => r.key === key)
    if (lane) {
      const open = [key, ...rowAncestors(lane)]
      if (open.some((k) => collapsed.has(k)))
        return setPrefs({ type: 'setCollapsedRows', keys: prefs.collapsedRows.filter((k) => !open.includes(k)) })
    }
    const i = rowIndex.get(key)
    if (i === undefined) return openTask(key)
    if (i >= rowLimit) setRowLimit(i + ROWS_STEP)
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-lane="${CSS.escape(key)}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.animate([{ backgroundColor: 'color-mix(in oklab, var(--primary) 12%, transparent)' }, { backgroundColor: 'transparent' }], {
        duration: 1200,
        easing: 'ease-out',
      })
    })
  }

  // ---- dropping cards ----
  /** Where a dragged card (or group) would land with the pointer at (x, y). */
  const cardDropAt = (x: number, y: number): CardDrop | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-cell]')
    if (!el || !boardRef.current?.contains(el)) return null
    const { row = NO_ROW, col = '' } = el.dataset
    const cell = cellKey(row, col)
    const g = dragging.group
    if (g) {
      const blocked = config.rows === 'rootParent' && row !== g.row ? BLOCKED.project : undefined
      return { row, col, cell, index: itemIndexAt(el, y), blocked, moving: 'group' }
    }
    const id = dragging.card
    if (!id) return null
    let next: CardDrop
    if (grouping) {
      // A subtask stays under its parent: inside the parent's group if the list has one, else in a new one.
      const parent = groupOf(id, row)
      const box = parent && el.querySelector<HTMLElement>(`[data-group="${CSS.escape(parent)}"]`)
      if (box) next = { row, col, cell, index: cardIndexAt(box, y), group: parent }
      else next = { row, col, cell, index: itemIndexAt(el, y), newGroup: parent ?? undefined }
    } else next = { row, col, cell, index: cardIndexAt(el, y) }
    next.blocked = blockReason(id, row, col) ?? undefined
    return next
  }
  /** Props for a cell cards can be dropped in. */
  const cellProps = (row: string, col: string) => ({ 'data-cell': '', 'data-row': row, 'data-col': col })

  const renderCards = (row: string, col: string) => {
    const k = cellKey(row, col)
    const all = view.cells.get(k) ?? []
    const ids = cellIds(k)
    const here = cardDrop?.cell === k ? cardDrop : null
    const card = (id: string, item?: boolean) => (
      <TaskCard
        key={id}
        id={id}
        idx={idx}
        config={cardConfig}
        labelById={labelById}
        onOpen={openTask}
        onFocus={focus}
        onJumpToRow={nestedRows && rowIndex.has(id) ? jumpToRow : undefined}
        move={moveFrom(row, col)}
        readOnly={readOnly}
        comments={counts.comments[id]}
        files={counts.attachments[id]}
        item={item}
      />
    )
    const slot = (top?: boolean) => <DropSlot key="__drop" top={top} blocked={here?.blocked} />

    let items: React.ReactNode[]
    if (grouping) {
      // Cards without a parent header, and one group per parent, in the list's order (see groupCell).
      items = groupCell(idx, ids, row).map((g) => {
        if (g.parentId === null) return card(g.ids[0], true)
        const cards = g.ids.map((id) => card(id))
        if (here?.group === g.parentId) cards.splice(Math.min(here.index, cards.length), 0, slot())
        return (
          <div key={g.parentId} data-item data-group={g.parentId} className="flex flex-col gap-1.5 rounded-lg bg-(--well) p-1.5 pt-0.5">
            <GroupHeader parentId={g.parentId} ids={g.ids} row={row} />
            {cards}
          </div>
        )
      })
      // Landing between the list's items: a card without a parent header, a group, or a card starting its parent's
      // group here (shown with the parent's name).
      if (here && !here.group) {
        const marker = here.newGroup ? (
          <div key="__drop" data-item-slot className="flex flex-col gap-1.5 rounded-lg bg-(--well) p-1.5 pt-0.5">
            <p className="flex h-7 items-center px-1 text-xs font-semibold text-muted-foreground">{data.tasks[here.newGroup]?.title}</p>
            {slot()}
          </div>
        ) : (
          slot(true)
        )
        items.splice(Math.min(here.index, items.length), 0, marker)
      }
    } else {
      items = ids.map((id) => card(id))
      if (here) items.splice(Math.min(here.index, items.length), 0, slot())
    }
    return (
      <>
        {items}
        {all.length > ids.length && (
          <button
            onClick={() => setCellLimits({ ...cellLimits, [k]: ids.length + CARDS_STEP * 2 })}
            className="rounded-md py-1.5 text-xs text-muted-foreground hover:bg-lane-hover hover:text-foreground"
          >
            Show {Math.min(all.length - ids.length, CARDS_STEP * 2)} more ({(all.length - ids.length).toLocaleString()} hidden)
          </button>
        )}
      </>
    )
  }

  // ---- dragging lists ----
  /** Where a dragged list would go with the pointer at x: an index among the lists. */
  const listDropAt = (x: number) => {
    const board = boardRef.current
    const row = board?.matches('[data-list-row]') ? board : board?.querySelector<HTMLElement>('[data-list-row]')
    return row ? listIndexAt(row, x) : null
  }
  const moveList = (id: string, i: number) => {
    const before = columns[i]?.key
    if (before === id || columns[i - 1]?.key === id) return // dropped where it already is
    run({ type: 'column.move', id, beforeId: before })
  }

  // ---- picking things up ----
  // A drag outlives the render it started in, so it calls the latest version of these.
  const live = useRef({ cardDropAt, listDropAt, drop, dropGroup, moveList })
  useLayoutEffect(() => {
    live.current = { cardDropAt, listDropAt, drop, dropGroup, moveList }
  })

  /** Cards, parent groups and lists are picked up here (they're marked with `data-drag`). */
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-drag]')
    if (readOnly || !handle || !e.currentTarget.contains(handle)) return
    const kind = handle.dataset.drag
    // Shared by cards and groups: follow the pointer, and drop where the marker was last shown. A card's marker
    // goes back to where it came from (`home`) when the pointer isn't over a list.
    const trackCards = (onDrop: (at: CardDrop) => void, onEnd: () => void, home: CardDrop | null = null) => {
      let last = home
      return {
        move: (x: number, y: number) => {
          const next = live.current.cardDropAt(x, y) ?? home
          last = next
          setCardDrop((c) => (next && sameDrop(c, next) ? c : next))
        },
        drop: () => last && onDrop(last),
        end: () => {
          onEnd()
          setCardDrop(null)
        },
      }
    }

    if (kind === 'card') {
      const id = handle.dataset.cardId!
      pointerDrag(e, {
        ghost: handle,
        start: () => {
          dragging.card = id
          dragging.height = handle.offsetHeight
          // The drop marker takes the card's place: leaving the card there too would push the cards below it away
          // from the pointer by a whole card. Hidden, it still counts in cardIndexAt, as dropCommand expects.
          const cell = handle.closest<HTMLElement>('[data-cell]')
          const group = handle.closest<HTMLElement>('[data-group]')
          const { row = NO_ROW, col = '' } = cell?.dataset ?? {}
          const within = group ?? cell
          const home: CardDrop = {
            row,
            col,
            cell: cellKey(row, col),
            // Inside its group, or (grouped, without a header) among the list's items, or among the list's cards.
            index: [...(within?.querySelectorAll(group || !grouping ? '[data-card-id]' : '[data-item]') ?? [])].indexOf(handle),
            group: group?.dataset.group,
          }
          // Show the marker before hiding the card, so nothing below it moves.
          flushSync(() => setCardDrop(home))
          handle.style.display = 'none'
          return trackCards(
            (at) => live.current.drop(id, at.row, at.col, at.index),
            () => {
              handle.style.display = ''
              dragging.card = null
            },
            home,
          )
        },
      })
    } else if (kind === 'group') {
      const parentId = handle.dataset.parentId!
      const box = handle.parentElement!
      const { row = NO_ROW, col = '' } = handle.closest<HTMLElement>('[data-cell]')?.dataset ?? {}
      const cell = cellKey(row, col)
      const ids = groupCell(idx, cellIds(cell), row).find((g) => g.parentId === parentId)?.ids ?? []
      pointerDrag(e, {
        ghost: box,
        start: () => {
          const g: GroupDrag = { parentId, ids, row, cell }
          dragging.group = g
          dragging.height = box.offsetHeight
          // Like a card: the marker takes the group's place, and it goes back there when not over a list.
          const items = [...(box.closest('[data-cell]')?.querySelectorAll('[data-item]') ?? [])]
          const home: CardDrop = { row, col, cell, index: items.indexOf(box), moving: 'group' }
          flushSync(() => setCardDrop(home))
          box.style.display = 'none'
          return trackCards(
            (at) => live.current.dropGroup(g, at.row, at.col, at.index),
            () => {
              box.style.display = ''
              dragging.group = null
            },
            home,
          )
        },
      })
    } else if (kind === 'list') {
      const list = handle.closest<HTMLElement>('[data-list-id]')
      const id = list?.dataset.listId
      if (!list || !id) return
      pointerDrag(e, {
        ghost: list,
        start: () => {
          dragging.list = id
          setListDrag({ id, height: list.offsetHeight })
          let last: number | null = null
          return {
            move: (x) => {
              last = live.current.listDropAt(x)
              setListDrop(last)
            },
            drop: () => last !== null && live.current.moveList(id, last),
            end: () => {
              dragging.list = null
              setListDrag(null)
              setListDrop(null)
            },
          }
        },
      })
    }
  }
  /** Inserts the list drop marker into a row of list elements. */
  const withListSlot = (items: React.ReactNode[], slot: (key: string) => React.ReactNode) => {
    if (listDrop === null || !listDrag) return items
    const from = columns.findIndex((c) => c.key === listDrag.id)
    if (listDrop === from || listDrop === from + 1) return items // no-op position
    const out = [...items]
    out.splice(listDrop, 0, slot('__list-drop'))
    return out
  }

  const columnHead = (c: Lane, joined: boolean) =>
    statusLists ? (
      <ListHeader
        col={idx.colById.get(c.key)!}
        count={colCount(c.key)}
        editing={editingList === c.key}
        setEditing={setEditingList}
        className={joined ? 'rounded-t-xl' : 'rounded-xl bg-lane'}
      />
    ) : (
      <header className={cn('flex h-10 items-center gap-2 px-3', !joined && 'rounded-xl bg-lane')}>
        <button onClick={() => openTask(c.taskId!)} className="min-w-0 truncate text-left text-sm font-semibold hover:underline">
          {c.title}
        </button>
        <StatusPill col={statusCol(idx, c.taskId!)} />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{colCount(c.key)}</span>
      </header>
    )

  const extras = (
    <>
      {view.columns.length > colLimit && (
        <button
          onClick={() => setColLimit(colLimit + COLS_STEP)}
          className="h-10 w-48 shrink-0 rounded-xl border border-dashed border-(--canvas-muted) text-sm text-(--canvas-muted) hover:text-(--canvas-fg)"
        >
          {view.columns.length - colLimit} more columns
        </button>
      )}
      {statusLists && (
        <div className="flex w-68 shrink-0 flex-col gap-2">
          <QuickAdd
            single
            label="Add another list"
            placeholder="List name"
            submitLabel="Add list"
            onCanvas
            className="rounded-xl bg-(--canvas-chip) p-1.5 [&>button]:h-9"
            onAdd={(name) => run({ type: 'column.create', name, category: 'doing' })}
          />
          {hiddenLists.length > 0 && <HiddenLists lists={hiddenLists} />}
        </div>
      )}
    </>
  )

  const allKeys = view.rows.map((r) => r.key)
  return (
    <>
      {grouped && view.rows.length > 0 && view.columns.length > 0 && (
        <ViewActions>
          <RowsToggle
            label="Collapse all rows"
            onClick={() => setPrefs({ type: 'setCollapsedRows', keys: [...new Set([...prefs.collapsedRows, ...allKeys])] })}
          >
            <ArrowsInSimple />
          </RowsToggle>
          <RowsToggle
            label="Expand all rows"
            onClick={() => setPrefs({ type: 'setCollapsedRows', keys: prefs.collapsedRows.filter((k) => !allKeys.includes(k)) })}
          >
            <ArrowsOutSimple />
          </RowsToggle>
        </ViewActions>
      )}
      {!view.columns.length && !statusLists ? (
        <Empty>{search ? 'No cards match your search.' : 'Nothing to show with these display settings.'}</Empty>
      ) : !grouped || !view.columns.length ? (
        // Trello-style: each list is one rounded column that scrolls on its own.
        <div ref={boardRef} onPointerDown={onPointerDown} data-list-row className="flex h-full items-start gap-3 overflow-x-auto p-4">
          {!view.columns.length && <AllListsHidden lists={hiddenLists} />}
          {withListSlot(
            columns.map((c) => {
              const col = idx.colById.get(c.key)
              return (
                <section
                  key={c.key}
                  data-list-id={c.key}
                  {...cellProps(NO_ROW, c.key)}
                  style={laneTint(col)}
                  className={cn(
                    'flex max-h-full w-68 shrink-0 flex-col rounded-xl bg-lane transition-opacity',
                    listDrag?.id === c.key && 'opacity-40',
                  )}
                >
                  {columnHead(c, true)}
                  <div className={cn('flex min-h-2 flex-col gap-2 overflow-y-auto px-2 pb-1', col?.color && 'pt-2')}>
                    {renderCards(NO_ROW, c.key)}
                  </div>
                  <div className="p-1.5 pt-1">
                    <QuickAdd onAdd={addIn(NO_ROW, c.key)} />
                  </div>
                </section>
              )
            }),
            (key) => (
              <div
                key={key}
                className="w-68 shrink-0 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5"
                style={{ height: listDrag?.height }}
              />
            ),
          )}
          {extras}
        </div>
      ) : (
        // Rows: list headers stay on top; each row is a band of cells.
        <div ref={boardRef} onPointerDown={onPointerDown} className="h-full overflow-auto">
          <div className="w-max min-w-full px-4 pb-8">
            <div
              className="sticky top-0 z-10 flex gap-3 pt-4 pb-2"
              // Same background as the board, pinned to the window so the gradient lines up seamlessly.
              style={{ background: 'var(--board-bg, var(--background))', backgroundAttachment: 'fixed' }}
              data-list-row
            >
              {withListSlot(
                columns.map((c) => (
                  <div key={c.key} data-list-id={c.key} className={cn('w-68 shrink-0 rounded-xl', listDrag?.id === c.key && 'opacity-40')}>
                    {columnHead(c, false)}
                  </div>
                )),
                // A thin marker that takes no room, so headers stay lined up with the cells below.
                (key) => (
                  <div key={key} className="relative -mx-1.5 w-0 shrink-0">
                    <div className="absolute inset-y-0 -left-0.5 w-1 rounded-full bg-primary" />
                  </div>
                ),
              )}
              {extras}
            </div>

            {rows.map((r) => (
              <section key={r.key} data-lane={r.key} className="mt-3 rounded-lg first-of-type:mt-1">
                <LaneHeader
                  lane={r}
                  nested={nestedRows}
                  collapsed={collapsed.has(r.key)}
                  count={collapsed.has(r.key) ? rowCount(r) : undefined}
                  onToggle={() => setPrefs({ type: 'toggleRow', key: r.key })}
                />
                {!collapsed.has(r.key) && (
                  <div className="flex gap-3">
                    {columns.map((c) => (
                      <div
                        key={c.key}
                        {...cellProps(r.key, c.key)}
                        style={laneTint(idx.colById.get(c.key))}
                        className="group/cell flex min-h-14 w-68 shrink-0 flex-col gap-2 rounded-xl bg-lane p-2"
                      >
                        {renderCards(r.key, c.key)}
                        <div className="opacity-0 transition-opacity group-hover/cell:opacity-100 focus-within:opacity-100">
                          <QuickAdd onAdd={addIn(r.key, c.key)} label="Add" className="h-7" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}

            {shownRows.length > rowLimit && (
              <button
                onClick={() => setRowLimit(rowLimit + ROWS_STEP)}
                className="mt-4 rounded-md px-3 py-1.5 text-sm text-(--canvas-muted) hover:bg-(--canvas-chip) hover:text-(--canvas-fg)"
              >
                Show more rows ({(shownRows.length - rowLimit).toLocaleString()} hidden)
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** Where a dragged card will land. Red with a reason when it can't go there. */
function DropSlot({ blocked, top }: { blocked?: string; top?: boolean }) {
  // `top`: between a grouped list's items, rather than between cards (see dnd.ts).
  const mark = top ? { 'data-item-slot': '' } : { 'data-drop-slot': '' }
  if (blocked)
    return (
      <div
        {...mark}
        className="rounded-lg border-2 border-dashed border-destructive/40 bg-destructive/5 px-3 py-2.5 text-center text-xs font-medium text-destructive"
      >
        {blocked}
      </div>
    )
  return (
    <div
      {...mark}
      className="shrink-0 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5"
      style={{ height: Math.min(Math.max(dragging.height, 36), 160) }}
    />
  )
}

/** Brings hidden lists back onto the board. */
function useShowLists() {
  const { prefs, setPrefs } = useBoard()
  const board = prefs.display.board
  return (ids: string[]) =>
    setPrefs({ type: 'setDisplay', config: { ...board, hiddenColumns: (board.hiddenColumns ?? []).filter((x) => !ids.includes(x)) } })
}

/** Stands in for the lists when every one of them is hidden, so the board never looks broken. */
function AllListsHidden({ lists }: { lists: StatusColumn[] }) {
  const show = useShowLists()
  return (
    <div className="flex w-68 shrink-0 flex-col items-center gap-3 rounded-xl border-2 border-dashed border-(--canvas-muted) p-5 text-center">
      <EyeSlash className="size-5 text-(--canvas-muted)" />
      <p className="text-sm text-(--canvas-fg)">Every list is hidden, so there’s nowhere to show cards.</p>
      <Button size="sm" variant="secondary" onClick={() => show(lists.map((c) => c.id))}>
        <Eye /> Show all lists
      </Button>
    </div>
  )
}

/** "2 hidden lists" button that brings hidden lists back. */
function HiddenLists({ lists }: { lists: StatusColumn[] }) {
  const show = useShowLists()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-9 items-center gap-2 rounded-xl px-3 text-sm text-(--canvas-muted) hover:bg-(--canvas-chip) hover:text-(--canvas-fg)">
          <EyeSlash className="size-4" />
          {lists.length === 1 ? `“${lists[0].name}” is hidden` : `${lists.length} hidden lists`}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Hidden from the board</DropdownMenuLabel>
        {lists.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => show([c.id])}>
            <StatusDot category={c.category} color={c.color} />
            {c.name}
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Eye /> Show
            </span>
          </DropdownMenuItem>
        ))}
        {lists.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => show(lists.map((c) => c.id))}>Show all lists</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RowsToggle({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function LaneHeader({
  lane,
  nested,
  collapsed,
  count,
  onToggle,
}: {
  lane: Lane
  nested: boolean
  collapsed: boolean
  /** Shown while collapsed: how many cards are tucked away. */
  count?: number
  onToggle: () => void
}) {
  const { data, prefs, idx, openTask, focus } = useBoard()
  const showProgress = prefs.display.board.parentDisplay.includes('progress')
  const task = lane.taskId ? data.tasks[lane.taskId] : undefined
  const depth = task && nested ? idx.depth.get(task.id)! - (prefs.focusId ? idx.depth.get(prefs.focusId)! + 1 : 0) : 0

  return (
    <header
      className={cn(
        'sticky left-4 mb-2 flex w-fit max-w-[calc(100vw-4rem)] items-center gap-3 py-1 text-(--canvas-fg)',
        depth > 0 && 'border-l-2 border-(--canvas-chip) pl-3',
      )}
      style={{ marginLeft: depth > 0 ? (depth - 1) * 20 : 0 }}
    >
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand row' : 'Collapse row'}
        title={collapsed ? 'Expand row' : 'Collapse row'}
        className="-mr-1.5 grid size-6 shrink-0 place-items-center rounded-md text-(--canvas-muted) hover:bg-(--canvas-chip) hover:text-(--canvas-fg)"
      >
        {collapsed ? <CaretRight weight="bold" className="size-3.5" /> : <CaretDown weight="bold" className="size-3.5" />}
      </button>
      {task ? (
        <>
          {nested && task.parentId && (
            <span className="truncate text-xs text-(--canvas-muted)">
              {ancestorsOf(data.tasks, task.id)
                .map((a) => data.tasks[a].title)
                .join(' › ')}{' '}
              ›
            </span>
          )}
          <button onClick={() => openTask(task.id)} className="truncate text-sm font-semibold hover:underline">
            {task.title}
          </button>
          {showProgress && idx.childrenOf.has(task.id) && (
            <ProgressBar done={idx.subDone.get(task.id)!} total={idx.subTotal.get(task.id)!} className="w-36" onCanvas />
          )}
          {idx.childrenOf.has(task.id) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => focus(task.id)}
                  aria-label="Focus on its subtasks"
                  className="grid size-6 place-items-center rounded-md text-(--canvas-muted) hover:bg-(--canvas-chip) hover:text-(--canvas-fg)"
                >
                  <Crosshair className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Focus on its subtasks</TooltipContent>
            </Tooltip>
          )}
        </>
      ) : prefs.display.board.rows === 'assignee' && lane.key !== UNASSIGNED ? (
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Avatar name={lane.title} /> {lane.title}
        </span>
      ) : (
        <span className="text-sm font-semibold text-(--canvas-muted)">{lane.title}</span>
      )}
      {count !== undefined && (
        <button
          onClick={onToggle}
          className="rounded-full bg-(--canvas-chip) px-2 py-0.5 text-xs text-(--canvas-muted) tabular-nums hover:text-(--canvas-fg)"
        >
          {count.toLocaleString()} {count === 1 ? 'card' : 'cards'}
        </button>
      )}
    </header>
  )
}
