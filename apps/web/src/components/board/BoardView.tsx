import { ArrowsInSimple, ArrowsOutSimple, CaretDown, CaretRight, Crosshair, Eye, EyeSlash } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
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
import { cn } from '@/lib/utils'
import { tone } from '@kanbanto/model/colors'
import { ancestorsOf, statusCol } from '@kanbanto/model/indexer'
import { filterCount, matchesFilter } from '@kanbanto/model/table'
import type { StatusColumn } from '@kanbanto/model/types'
import { buildView, cellKey, groupCell, groupsSubtasks, NO_ROW, UNASSIGNED, type CardGroup, type Lane } from '@kanbanto/model/view'
import { CARD_DRAG_TYPE, cardIndexAt, dragging, GROUP_DRAG_TYPE, groupAttr, LIST_DRAG_TYPE, listIndexAt, type GroupDrag } from './dnd'
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
 * Where a dragged card (or a parent's group) would land: a cell and a position in it.
 * With grouped subtasks, `group` is the group the card lands in and `index` is its position there.
 * `blocked` says why it can't go there.
 */
type CardDrop = { cell: string; index: number; blocked?: string; group?: string; moving?: 'group' }
const sameDrop = (a: CardDrop | null, b: CardDrop) =>
  !!a && a.cell === b.cell && a.index === b.index && a.blocked === b.blocked && a.group === b.group && a.moving === b.moving

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
  const { data, prefs, setPrefs, idx, run, openTask, createTask, focus, readOnly, counts } = useBoard()
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
  const [groupDrag, setGroupDrag] = useState<{ parentId: string; cell: string } | null>(null)
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

  /** A parent's header dropped in another list: all its subtasks from the list it came from move there. */
  const dropGroup = (g: GroupDrag, row: string, col: string) => {
    const cmd = dropGroupCommand(rules, g, row, col)
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
  const cellProps = (row: string, col: string) => {
    const k = cellKey(row, col)
    return {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        const g = dragging.group
        if (g) {
          e.preventDefault()
          const blocked = config.rows === 'rootParent' && row !== g.row ? 'Can’t move between projects here' : undefined
          const next: CardDrop = { cell: k, index: 0, blocked, moving: 'group' }
          if (!sameDrop(cardDrop, next)) setCardDrop(next)
          return
        }
        const id = dragging.card
        if (!id) return
        e.preventDefault()
        let next: CardDrop
        if (grouping) {
          // The card can only land inside its own parent's group, so measure within that group.
          const group = groupAttr(groupOf(id, row))
          const el = e.currentTarget.querySelector<HTMLElement>(`[data-group="${CSS.escape(group)}"]`)
          next = { cell: k, index: el ? cardIndexAt(el, e.clientY) : 0, group }
        } else next = { cell: k, index: cardIndexAt(e.currentTarget, e.clientY) }
        next.blocked = blockReason(id, row, col) ?? undefined
        e.dataTransfer.dropEffect = next.blocked ? 'none' : 'move'
        if (!sameDrop(cardDrop, next)) setCardDrop(next)
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setCardDrop((c) => (c?.cell === k ? null : c))
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        if (e.dataTransfer.types.includes(GROUP_DRAG_TYPE) && dragging.group) {
          e.preventDefault()
          setCardDrop(null)
          dropGroup(dragging.group, row, col)
          return
        }
        const id = e.dataTransfer.getData(CARD_DRAG_TYPE)
        if (!id) return
        e.preventDefault()
        const at = cardDrop?.cell === k ? cardDrop.index : cellIds(k).length
        setCardDrop(null)
        drop(id, row, col, at)
      },
    }
  }

  const renderCards = (row: string, col: string) => {
    const k = cellKey(row, col)
    const all = view.cells.get(k) ?? []
    const ids = cellIds(k)
    const here = cardDrop?.cell === k ? cardDrop : null
    const card = (id: string) => (
      <TaskCard
        key={id}
        id={id}
        idx={idx}
        config={cardConfig}
        labelById={labelById}
        onOpen={openTask}
        onFocus={focus}
        onDragEnd={() => setCardDrop(null)}
        onJumpToRow={nestedRows && rowIndex.has(id) ? jumpToRow : undefined}
        readOnly={readOnly}
        comments={counts.comments[id]}
        files={counts.attachments[id]}
      />
    )
    const slot = <DropSlot key="__drop" blocked={here?.blocked} />

    let items: React.ReactNode[]
    if (grouping) {
      const groups = groupCell(idx, ids, row)
      const renderGroup = (g: CardGroup) => {
        const key = groupAttr(g.parentId)
        const cards = g.ids.map(card)
        if (here && !here.moving && here.group === key) cards.splice(Math.min(here.index, cards.length), 0, slot)
        if (g.parentId === null)
          return (
            <div key={key} data-group={key} className="flex flex-col gap-2">
              {cards}
            </div>
          )
        return (
          <div
            key={key}
            data-group={key}
            className={cn(
              'flex flex-col gap-1.5 rounded-lg bg-(--well) p-1.5 pt-0.5 transition-opacity',
              groupDrag?.parentId === g.parentId && groupDrag.cell === k && 'opacity-40',
            )}
          >
            <GroupHeader
              parentId={g.parentId}
              ids={g.ids}
              row={row}
              cell={k}
              onDragStart={(parentId, cell) => setGroupDrag({ parentId, cell })}
              onDragEnd={() => {
                setGroupDrag(null)
                setCardDrop(null)
              }}
            />
            {cards}
          </div>
        )
      }
      items = groups.map(renderGroup)
      // The card's parent has no group in this list yet: show where the new group will appear.
      if (here && !here.moving && here.group && !groups.some((g) => groupAttr(g.parentId) === here.group)) {
        const ghost =
          here.group === groupAttr(null) ? (
            <div key="__ghost" data-group={here.group} className="flex flex-col gap-2">
              {slot}
            </div>
          ) : (
            <div key="__ghost" data-group={here.group} className="flex flex-col gap-1.5 rounded-lg bg-(--well) p-1.5 pt-0.5">
              <p className="flex h-7 items-center px-1 text-xs font-semibold text-muted-foreground">{data.tasks[here.group]?.title}</p>
              {slot}
            </div>
          )
        if (here.group === groupAttr(null)) items.unshift(ghost)
        else items.push(ghost)
      }
      if (here?.moving === 'group') items.push(<DropSlot key="__drop" blocked={here.blocked} />)
    } else {
      items = ids.map(card)
      if (here) items.splice(Math.min(here.index, items.length), 0, slot)
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
  const listRowProps = {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!dragging.list) return
      e.preventDefault()
      const i = listIndexAt(e.currentTarget, e.clientX)
      if (i !== listDrop) setListDrop(i)
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setListDrop(null)
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      const id = e.dataTransfer.getData(LIST_DRAG_TYPE)
      if (!id) return
      e.preventDefault()
      const i = listDrop ?? columns.length
      setListDrop(null)
      const before = columns[i]?.key
      if (before === id || columns[i - 1]?.key === id) return // dropped where it already is
      run({ type: 'column.move', id, beforeId: before })
    },
  }
  const listDragProps = {
    onDragStart: (id: string, height: number) => setListDrag({ id, height }),
    onDragEnd: () => {
      setListDrag(null)
      setListDrop(null)
    },
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
        {...listDragProps}
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
        <div className="flex h-full items-start gap-3 overflow-x-auto p-4" {...listRowProps}>
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
        <div className="h-full overflow-auto">
          <div className="w-max min-w-full px-4 pb-8">
            <div
              className="sticky top-0 z-10 flex gap-3 pt-4 pb-2"
              // Same background as the board, pinned to the window so the gradient lines up seamlessly.
              style={{ background: 'var(--board-bg, var(--background))', backgroundAttachment: 'fixed' }}
              {...listRowProps}
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
function DropSlot({ blocked }: { blocked?: string }) {
  if (blocked)
    return (
      <div className="rounded-lg border-2 border-dashed border-destructive/40 bg-destructive/5 px-3 py-2.5 text-center text-xs font-medium text-destructive">
        {blocked}
      </div>
    )
  return (
    <div
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
