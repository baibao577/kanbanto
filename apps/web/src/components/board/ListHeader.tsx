import { ArrowLeft, ArrowRight, DotsThree, EyeSlash, PencilSimple, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
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
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, type Category, type StatusColumn } from '@kanbanto/model/types'
import { dragging, LIST_DRAG_TYPE } from './dnd'

interface Props {
  col: StatusColumn
  count: number
  editing: boolean
  setEditing: (id: string | null) => void
  onDragStart: (id: string, height: number) => void
  onDragEnd: () => void
  className?: string
}

/** A status list's header: rename in place, color, what it counts as, reorder, hide, delete. */
export function ListHeader({ col, count, editing, setEditing, onDragStart, onDragEnd, className }: Props) {
  const { data, prefs, setPrefs, run, readOnly } = useBoard()
  const [deleting, setDeleting] = useState(false)
  const columns = data.columns
  const i = columns.findIndex((c) => c.id === col.id)
  const onlyList = columns.length < 2
  const board = prefs.display.board

  const rename = (name: string) => {
    setEditing(null)
    if (name.trim() && name.trim() !== col.name) run({ type: 'column.update', id: col.id, fields: { name } })
  }
  const hide = () => setPrefs({ type: 'setDisplay', config: { ...board, hiddenColumns: [...(board.hiddenColumns ?? []), col.id] } })

  return (
    <header
      draggable={!editing && !readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(LIST_DRAG_TYPE, col.id)
        e.dataTransfer.effectAllowed = 'move'
        dragging.list = col.id
        onDragStart(col.id, (e.currentTarget.closest('[data-list-id]') as HTMLElement | null)?.offsetHeight ?? 40)
      }}
      onDragEnd={() => {
        dragging.list = null
        onDragEnd()
      }}
      // A list's color fills its header box; the dot then shows what the list counts as.
      style={col.color ? { backgroundColor: `color-mix(in oklab, ${tone(col.color)} var(--tint-header), var(--lane))` } : undefined}
      className={cn('flex h-10 cursor-grab items-center gap-2 px-3 active:cursor-grabbing', className)}
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

      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`${col.name} list options`}
              className={cn(
                'ml-auto grid size-7 shrink-0 place-items-center rounded-md hover:bg-foreground/8 hover:text-foreground',
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
