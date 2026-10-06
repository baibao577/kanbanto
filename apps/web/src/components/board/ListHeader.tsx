import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowsInLineHorizontal,
  DotsThree,
  EyeSlash,
  PencilSimple,
  SortAscending,
  Trash,
} from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useBoard } from '@/app/board-context'
import { ColorSwatches, StatusDot } from '@/components/common/bits'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { tone } from '@kanbanto/model/colors'
import { listSort, sortComparator } from '@kanbanto/model/table'
import {
  CATEGORIES,
  CATEGORY_HINT,
  CATEGORY_LABEL,
  isReversed,
  LIST_ORDER_KEYS,
  listOrderKey,
  reversed,
  type Category,
  type ListOrder,
  type StatusColumn,
} from '@kanbanto/model/types'
import { byHand } from '@kanbanto/model/view'
import { ORDER_LABEL, withListCollapsed, withListOrder } from './listOrder'

interface Props {
  col: StatusColumn
  count: number
  editing: boolean
  setEditing: (id: string | null) => void
  /** Asks which of a done list's older cards to archive (see ArchiveOlderDialog). */
  onArchiveOlder: () => void
  className?: string
}

/**
 * A status list's header: rename in place, color, the order of its cards, what it counts as, reorder, hide, delete;
 * and, for a list of finished work, archiving its older cards.
 */
export function ListHeader({ col, count, editing, setEditing, onArchiveOlder, className }: Props) {
  const { data, idx, prefs, setPrefs, run, undo, readOnly } = useBoard()
  const [deleting, setDeleting] = useState(false)
  const columns = data.columns
  const i = columns.findIndex((c) => c.id === col.id)
  const onlyList = columns.length < 2
  const board = prefs.display.board

  const rename = (name: string) => {
    setEditing(null)
    if (name.trim() && name.trim() !== col.name) run({ type: 'column.update', id: col.id, fields: { name } })
  }
  // Shown in another order than the one made by hand (which is kept, and comes back with "By hand").
  const order = board.listOrder?.[col.id]
  const setOrder = (by: ListOrder | undefined) => setPrefs({ type: 'setDisplay', config: withListOrder(board, col.id, by) })
  /** The order shown becomes the order by hand (replacing the one made before), so cards can be dragged from there. */
  const keepOrder = () => {
    if (!order) return
    // (A parent whose status follows its subtasks isn't placed by hand in a list.)
    const mine = Object.keys(data.tasks).filter((id) => idx.status.get(id) === col.id && data.tasks[id].status === col.id)
    const list = byHand(idx, mine).sort(sortComparator(idx, listSort(order), new Map()))
    if (!run({ type: 'tasks.moveToList', ids: list, status: col.id, list })) return
    setOrder(undefined)
    const back = () => {
      undo()
      setOrder(order)
    }
    toast('This order is now the list’s order by hand', { id: 'undo', action: { label: 'Undo', onClick: back } })
  }
  const hide = () => setPrefs({ type: 'setDisplay', config: { ...board, hiddenColumns: [...(board.hiddenColumns ?? []), col.id] } })

  return (
    <header
      // Picked up by the board (BoardView), which moves the list.
      data-drag={editing || readOnly ? undefined : 'list'}
      // A list's color fills its header box; the dot then shows what the list counts as.
      style={col.color ? { backgroundColor: `color-mix(in oklab, ${tone(col.color)} var(--tint-header), var(--lane))` } : undefined}
      className={cn('drag-handle flex h-10 cursor-grab items-center gap-2 px-3 active:cursor-grabbing', className)}
    >
      <StatusDot category={col.category} className={col.color ? 'ring-2 ring-card/70' : undefined} />
      {editing ? (
        <input
          autoFocus
          defaultValue={col.name}
          aria-label="List name"
          onFocus={(e) => e.target.select()}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(null)
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      ) : (
        <button
          onClick={() => !readOnly && setEditing(col.id)}
          title={readOnly ? undefined : 'Rename'}
          className="min-w-0 truncate rounded px-0.5 text-left text-sm font-semibold hover:bg-foreground/5"
        >
          {col.name}
        </button>
      )}
      <span className={cn('text-xs tabular-nums', col.color ? 'text-foreground/70' : 'text-muted-foreground')}>{count}</span>
      {order && (
        <span
          title={`Ordered by ${ORDER_LABEL[listOrderKey(order)][0].toLowerCase()}: ${ORDER_LABEL[listOrderKey(order)][isReversed(order) ? 2 : 1].toLowerCase()}`}
          className={cn('flex items-center gap-1 text-xs', col.color ? 'text-foreground/70' : 'text-muted-foreground')}
        >
          <SortAscending className="size-3.5" />
          {ORDER_LABEL[listOrderKey(order)][0]}
        </span>
      )}

      {/* Folding a list is only how you see it, so people who can't edit can do it too. */}
      <button
        aria-label={`Collapse ${col.name}`}
        title="Collapse list"
        onClick={() => setPrefs({ type: 'setDisplay', config: withListCollapsed(board, col.id, true) })}
        className={cn(
          'ml-auto grid size-7 shrink-0 place-items-center rounded-md hover:bg-foreground/8 hover:text-foreground',
          col.color ? 'text-foreground/70' : 'text-muted-foreground',
        )}
      >
        <ArrowsInLineHorizontal className="size-4" />
      </button>
      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`${col.name} list options`}
              className={cn(
                '-ml-1.5 grid size-7 shrink-0 place-items-center rounded-md hover:bg-foreground/8 hover:text-foreground',
                col.color ? 'text-foreground/70' : 'text-muted-foreground',
              )}
            >
              <DotsThree weight="bold" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuItem onSelect={() => setEditing(col.id)}>
              <PencilSimple /> Rename
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span
                  className="size-4 rounded"
                  style={col.color ? { backgroundColor: tone(col.color) } : { boxShadow: 'inset 0 0 0 1.5px var(--border)' }}
                />
                Color
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60 p-2">
                <ColorSwatches
                  value={col.color}
                  noneLabel="No color"
                  onChange={(color) => run({ type: 'column.update', id: col.id, fields: { color: color ?? null } })}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SortAscending /> Order cards by
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <DropdownMenuRadioGroup
                  value={order ? listOrderKey(order) : ''}
                  onValueChange={(v) => setOrder((v || undefined) as ListOrder | undefined)}
                >
                  <DropdownMenuRadioItem value="">
                    By hand
                    <span className="ml-auto text-xs text-muted-foreground">As you dragged them</span>
                  </DropdownMenuRadioItem>
                  {LIST_ORDER_KEYS.map((by) => (
                    <DropdownMenuRadioItem key={by} value={by}>
                      {ORDER_LABEL[by][0]}
                      {/* (The one in use says which way round it is now.) */}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {ORDER_LABEL[by][order && listOrderKey(order) === by && isReversed(order) ? 2 : 1]}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={!!order && isReversed(order)}
                  disabled={!order}
                  onCheckedChange={() => order && setOrder(reversed(order))}
                >
                  Reverse the order
                </DropdownMenuCheckboxItem>
                {order && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={keepOrder} className="items-start">
                      <span>
                        <span className="block">Keep this order</span>
                        <span className="block text-xs text-muted-foreground">Replaces the order by hand, so you can drag cards from here</span>
                      </span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem disabled={i === 0} onSelect={() => run({ type: 'column.move', id: col.id, beforeId: columns[i - 1]?.id })}>
              <ArrowLeft /> Move left
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={i === columns.length - 1}
              onSelect={() => run({ type: 'column.move', id: col.id, beforeId: columns[i + 2]?.id })}
            >
              <ArrowRight /> Move right
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Cards in this list are</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={col.category}
              onValueChange={(v) => run({ type: 'column.update', id: col.id, fields: { category: v as Category } })}
            >
              {CATEGORIES.map((c) => (
                <DropdownMenuRadioItem key={c} value={c} className="items-start">
                  <StatusDot category={c} className="mt-1.5" />
                  <span>
                    <span className="block">{CATEGORY_LABEL[c]}</span>
                    <span className="block text-xs text-muted-foreground">{CATEGORY_HINT[c]}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            {col.category === 'done' && (
              <DropdownMenuItem onSelect={onArchiveOlder}>
                <Archive /> Archive older cards…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={hide}>
              <EyeSlash /> Hide list
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={onlyList} onSelect={() => setDeleting(true)}>
              <Trash /> Delete list…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DeleteListDialog col={col} open={deleting} onOpenChange={setDeleting} />
    </header>
  )
}

/**
 * A folded list: a narrow strip with what it counts as, how many cards and (given the height, `tall`) its name. Click
 * to open it again; it can still be dragged to another place, and cards can be dropped on it (`dropping`). `totals`:
 * what its cards add up to, a line per field, said with the count when you point at it.
 */
export function CollapsedList({
  col,
  count,
  totals,
  tall,
  dropping,
  className,
  ...rest
}: { col: StatusColumn; count: number; totals?: string; tall?: boolean; dropping?: 'ok' | 'blocked' } & React.ComponentProps<'button'>) {
  const { prefs, setPrefs, readOnly } = useBoard()
  return (
    <button
      {...rest}
      data-list-id={col.id}
      data-drag={readOnly ? undefined : 'list'}
      aria-label={`Expand ${col.name}`}
      aria-expanded={false}
      title={`${col.name} · ${count} ${count === 1 ? 'card' : 'cards'}${totals ? `\n${totals}` : ''}\nClick to expand`}
      onClick={() => setPrefs({ type: 'setDisplay', config: withListCollapsed(prefs.display.board, col.id, false) })}
      className={cn(
        'drag-handle flex w-10 shrink-0 cursor-pointer items-center rounded-xl bg-lane text-sm font-semibold transition-[opacity,box-shadow] hover:bg-lane-hover',
        tall ? 'max-h-full min-h-36 flex-col gap-2 py-3' : 'h-10 justify-center gap-1',
        dropping === 'ok' && 'ring-2 ring-primary/60',
        dropping === 'blocked' && 'ring-2 ring-destructive/50',
        className,
      )}
    >
      <StatusDot category={col.category} className={col.color ? 'ring-2 ring-card/70' : undefined} />
      <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
      {tall && <span className="min-h-0 truncate [writing-mode:vertical-rl]">{col.name}</span>}
    </button>
  )
}

function DeleteListDialog({ col, open, onOpenChange }: { col: StatusColumn; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, prefs, run } = useBoard()
  const others = data.columns.filter((c) => c.id !== col.id)
  // Suggest somewhere you can see: a visible list of the same kind, else the list next to it.
  const hidden = new Set(prefs.display.board.hiddenColumns ?? [])
  const visible = others.filter((c) => !hidden.has(c.id))
  const i = data.columns.findIndex((c) => c.id === col.id)
  const neighbour = [...data.columns.slice(0, i).reverse(), ...data.columns.slice(i + 1)].find((c) => !hidden.has(c.id))
  const suggested = (visible.find((c) => c.category === col.category) ?? neighbour ?? others[0])?.id
  // Only keep the user's pick while that list still exists; otherwise fall back to the current suggestion.
  const [picked, setMoveTo] = useState<string>()
  const moveTo = picked && others.some((c) => c.id === picked) ? picked : suggested
  const stored = open ? Object.values(data.tasks).filter((t) => t.status === col.id).length : 0

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{col.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {stored ? `It has ${stored} ${stored === 1 ? 'card' : 'cards'}. Choose where they should go.` : 'This list is empty.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {stored > 0 && (
          <Select value={moveTo} onValueChange={setMoveTo}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {others.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  Move them to “{c.name}”{hidden.has(c.id) ? ' (hidden)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => moveTo && run({ type: 'column.delete', id: col.id, moveTo })}
          >
            Delete list
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
