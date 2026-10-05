import { ArrowSquareOut, CaretDown, CaretRight, LockSimple, Tray, X } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import type { TaskFields } from '@kanbanto/model/commands'
import type { ViewConfig } from '@kanbanto/model/types'
import { buildView, cellKey, NO_ROW } from '@kanbanto/model/view'
import { useBoard } from '@/app/board-context'
import { hrefFor } from '@/app/router'
import { useInbox } from '@/app/use-inbox'
import { DropSlot } from '@/components/board/BoardView'
import { cardIndexAt, cellAt, dragging, zones, type DropPlace, type DropZone } from '@/components/board/dnd'
import { blockReason, dropCommand, newCardIn, type DropContext } from '@/components/board/dropRules'
import { QuickAdd } from '@/components/board/QuickAdd'
import { TaskCard } from '@/components/board/TaskCard'
import { StatusDot } from '@/components/common/bits'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { rollUp } from '@/components/time/logging'
import { pointerDrag } from '@/lib/pointerDrag'
import { useNow } from '@/lib/useNow'
import { cn } from '@/lib/utils'

/**
 * How the panel shows the Inbox, whatever its own Board tab is set to: its lists, one card per task (subtasks stay
 * on their card), in the order made by hand.
 */
const PANEL: ViewConfig = { columns: 'status', rows: 'none', filter: 'topLevel', parentDisplay: ['progress'] }
/** A position past the last card of any list: the end. */
const END = 1_000_000
/** The most cards a list shows here: the rest are on the board. */
const SHOWN = 100

const FOLD_KEY = 'kankan:inbox:fold'
const readFolds = (): Record<string, boolean> => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}')
    return saved && typeof saved === 'object' ? (saved as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

const ICON = 'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'

/** The panel's frame: its name, the way to the Inbox as a board, and (below) who can see it. */
export function InboxShell({ loading, children, ...rest }: { loading?: boolean; children?: ReactNode } & React.ComponentProps<'aside'>) {
  const { boardId, phone, show } = useInbox()
  return (
    <aside
      aria-label="Inbox"
      {...rest}
      className={cn('flex h-full min-h-0 flex-col bg-background', phone ? 'w-full' : 'w-76 border-r', rest.className)}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <Tray weight="fill" className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Inbox</h2>
        <div className="ml-auto flex items-center">
          {boardId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <a href={hrefFor({ page: 'board', id: boardId })} aria-label="Open as a board" className={ICON}>
                  <ArrowSquareOut className="size-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent>Open as a board</TooltipContent>
            </Tooltip>
          )}
          <button aria-label="Close Inbox" onClick={() => show(false)} className={ICON}>
            <X className="size-4" />
          </button>
        </div>
      </header>
      {children ?? (
        <p className="flex-1 p-4 text-sm text-muted-foreground">{loading ? 'Loading…' : 'Your Inbox couldn’t be opened. Try again in a moment.'}</p>
      )}
      <p className="flex shrink-0 items-center justify-center gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
        <LockSimple className="size-3.5" /> Only you can see your Inbox
      </p>
    </aside>
  )
}

/** Where a card dragged inside the panel would land: a list, and a position among its cards. */
type Drop = { col: string; index: number }
const sameDrop = (a: Drop | null, b: Drop) => !!a && a.col === b.col && a.index === b.index

/**
 * The Inbox as a stack: "Add a card", then a section for each of its lists that folds (finished ones start folded).
 * A card dragged to another section changes list; dragged out onto the open board, it's filed there, where it was
 * dropped (`onFile`). Rendered inside the Inbox's own board context (see InboxLive).
 */
export function InboxPanel({
  filing,
  onFile,
  onMoveHere,
}: {
  /** Cards on their way to a board: not shown any more. */
  filing: ReadonlySet<string>
  onFile: (id: string, at: DropPlace) => Promise<void>
  /** From a card's menu: asks where on the open board it should go. */
  onMoveHere: (id: string) => void
}) {
  const { data, idx, run, counts, openTask, focus, createTask, moveToBoard, readOnly } = useBoard()
  const { page, phone, addSignal, addTaken } = useInbox()
  // ("Add a card" was asked for, maybe before the panel was here: once the field has it, it's done with.)
  useEffect(() => {
    if (addSignal) addTaken()
  }, [addSignal, addTaken])
  const now = useNow(3_600_000)
  const view = useMemo(() => buildView(idx, PANEL, { now }), [idx, now])
  const labelById = useMemo(() => new Map(data.labels.map((l) => [l.id, l])), [data.labels])
  const frontFields = useMemo(() => data.fields.filter((f) => f.front), [data.fields])
  const timeOf = useMemo(() => rollUp(counts.time, idx.childrenOf), [counts.time, idx.childrenOf])
  const rules: DropContext = useMemo(() => ({ data, idx, config: PANEL, cells: view.cells }), [data, idx, view.cells])
  const cardsOf = (col: string) => view.cells.get(cellKey(NO_ROW, col)) ?? []

  // Folded sections, remembered on this device. A list of finished cards is folded until it's opened.
  const [folds, setFolds] = useState(readFolds)
  const isFolded = (col: string) => folds[col] ?? idx.colById.get(col)?.category === 'done'
  const fold = (col: string, folded: boolean) => {
    const next = { ...folds, [col]: folded }
    setFolds(next)
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(next))
    } catch {
      // (Private browsing: it just isn't remembered.)
    }
  }

  // A card you can file on the open board: one you may add to, with the board in view (not under a phone's sheet).
  const here = page?.canEdit ? page : null
  const [drop, setDrop] = useState<Drop | null>(null)
  const panel = useRef<HTMLElement>(null)

  const add = (title: string, extra?: TaskFields) => {
    const first = idx.firstOf.todo
    const { fields, rankAfter } = newCardIn(rules, undefined, NO_ROW, first, title)
    if (createTask(null, { ...fields, ...extra }, { rankAfter }) && isFolded(first)) fold(first, false)
  }

  /** A card dropped in a list of the panel at position `at` (see dropCommand). */
  const dropIn = (id: string, col: string, at: number) => {
    const blocked = blockReason(rules, id, NO_ROW, col)
    if (blocked) return void toast(`“${data.tasks[id]?.title}” follows its subtasks`, { description: 'Move its subtasks instead.' })
    const cmd = dropCommand(rules, id, NO_ROW, col, at)
    if (cmd) run(cmd)
  }
  /** Where a dragged card would land in the panel with the pointer at (x, y): on a folded list, at its end. */
  const dropAt = (x: number, y: number): Drop | null => {
    const cell = panel.current && cellAt(panel.current, x, y)
    const col = cell?.dataset.col

    if (!cell || !col) return null
    return { col, index: isFolded(col) ? END : cardIndexAt(cell, y) }
  }
  // A drag outlives the render it started in, so it calls the latest version of these.
  const live = useRef({ dropIn, dropAt, onFile, canFile: !!here && !phone })
  useLayoutEffect(() => {
    live.current = { dropIn, dropAt, onFile, canFile: !!here && !phone }
  })

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-drag="card"]')
    if (!handle || !e.currentTarget.contains(handle)) return
    const id = handle.dataset.cardId!
    pointerDrag(e, {
      ghost: handle,
      start: () => {
        dragging.outside = true
        dragging.height = handle.offsetHeight
        // As on a board: the marker takes the card's place, and goes back there when the pointer is nowhere it can land.
        const cell = handle.closest<HTMLElement>('[data-cell]')
        const home: Drop = { col: cell?.dataset.col ?? '', index: [...(cell?.querySelectorAll('[data-card-id]') ?? [])].indexOf(handle) }
        flushSync(() => setDrop(home))
        handle.style.display = 'none'
        // (Between two lists, or under the last one, it stays aimed at where it was: the lists move as the marker does.)
        let inside: Drop = home
        // On the open board: where it would land, and the zone showing it.
        let outside: DropPlace | null = null
        let zone: DropZone | null = null
        return {
          move: (x, y) => {
            const under = document.elementFromPoint(x, y)
            const z = panel.current?.contains(under) || !live.current.canFile ? null : (zones.lists ?? zones.page)
            if (zone && zone !== z) zone.leave()
            zone = z
            outside = z?.over(x, y) ?? null
            inside = outside || !panel.current?.contains(under) ? home : (live.current.dropAt(x, y) ?? inside)
            setDrop((d) => (outside ? null : sameDrop(d, inside) ? d : inside))
          },
          drop: () => {
            if (!outside) return live.current.dropIn(id, inside.col, inside.index)
            // The marker stays where the card was dropped until it has arrived (or was refused).
            const shown = zone
            zone = null
            void live.current.onFile(id, outside).finally(() => shown?.leave())
          },
          end: () => {
            handle.style.display = ''
            dragging.outside = false
            zone?.leave()
            setDrop(null)
          },
        }
      },
    })
  }

  const empty = idx.preorder.length === 0
  return (
    <InboxShell ref={panel} onPointerDown={readOnly ? undefined : onPointerDown}>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <QuickAdd dates onAdd={add} focusSignal={addSignal} className="[&_textarea]:bg-(--tile)" />
        {empty && (
          <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground">
            Note anything here, wherever you are. {here ? `Drag a card onto “${here.name}” to put it there` : 'Open a board to drag a card onto it'},
            or keep it here and work through the lists below.
          </p>
        )}
        {view.columns.map((c) => {
          const col = idx.colById.get(c.key)
          const all = cardsOf(c.key).filter((id) => !filing.has(id))
          const ids = all.slice(0, SHOWN)
          const folded = isFolded(c.key)
          const landing = drop?.col === c.key ? drop : null
          const older = view.olderDone.get(c.key) ?? 0
          const cards: ReactNode[] = ids.map((id) => (
            <TaskCard
              key={id}
              id={id}
              idx={idx}
              config={PANEL}
              labelById={labelById}
              frontFields={frontFields}
              onOpen={openTask}
              onFocus={focus}
              readOnly={readOnly}
              comments={counts.comments[id]}
              files={counts.attachments[id]}
              lastComment={counts.lastComment[id]}
              time={timeOf(id)}
              move={{
                lists: view.columns,
                col: c.key,
                toBoard: moveToBoard,
                archive: (card, complete) => run({ type: 'task.archive', id: card, complete }),
                to: (card, where) => {
                  const to = typeof where === 'object' ? where.col : c.key
                  dropIn(card, to, where === 'top' ? 0 : END)
                },
                here: here ? { name: here.name, go: onMoveHere } : undefined,
              }}
            />
          ))
          if (landing && !folded) cards.splice(Math.min(landing.index, cards.length), 0, <DropSlot key="__drop" />)
          return (
            <section
              key={c.key}
              data-cell=""
              data-row={NO_ROW}
              data-col={c.key}
              className={cn('rounded-xl bg-lane transition-shadow', landing && folded && 'ring-2 ring-primary/60')}
            >
              <button
                aria-expanded={!folded}
                onClick={() => fold(c.key, !folded)}
                className="flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-sm font-semibold"
              >
                {folded ? (
                  <CaretRight weight="bold" className="size-3 text-muted-foreground" />
                ) : (
                  <CaretDown weight="bold" className="size-3 text-muted-foreground" />
                )}
                {col && <StatusDot category={col.category} color={col.color} />}
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{all.length}</span>
              </button>
              {!folded && (cards.length > 0 || older > 0) && (
                <div className="flex flex-col gap-2 px-2 pb-2">
                  {cards}
                  {(all.length > ids.length || older > 0) && (
                    <p className="px-1 text-xs text-muted-foreground">
                      {all.length > ids.length ? `${(all.length - ids.length).toLocaleString()} more` : `${older.toLocaleString()} older`}: open the
                      Inbox as a board to see them.
                    </p>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </InboxShell>
  )
}
