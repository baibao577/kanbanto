import { ArrowSquareOut, Crosshair, DotsSixVertical, DotsThree } from '@phosphor-icons/react'
import { useBoard } from '@/app/board-context'
import { StatusDot } from '@/components/common/bits'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ancestorsOf, descendantsOf, isLeaf } from '@kanbanto/model/indexer'
import { dragging, GROUP_DRAG_TYPE } from './dnd'

interface Props {
  parentId: string
  /** The subtasks under this header in this list. */
  ids: string[]
  row: string
  cell: string
  onDragStart: (parentId: string, cell: string) => void
  onDragEnd: () => void
}

/**
 * A parent task shown as a header over its subtasks inside a list (never as a card).
 * Drag it to move the subtasks under it together; its menu can move all of its subtasks at once.
 */
export function GroupHeader({ parentId, ids, row, cell, onDragStart, onDragEnd }: Props) {
  const { data, prefs, idx, run, openTask, focus, readOnly } = useBoard()
  const t = data.tasks[parentId]
  // Path between the row's task (or the top) and this parent, for deeper nesting.
  const above = ancestorsOf(data.tasks, parentId)
  const fromRow = above.indexOf(row)
  const path = (fromRow === -1 ? above : above.slice(fromRow + 1)).map((a) => data.tasks[a].title)
  const leaves = descendantsOf(idx, parentId).filter((d) => isLeaf(idx, d))
  const hidden = new Set(prefs.display.board.hiddenColumns ?? [])

  // Moved subtasks drop their old drag positions, so they line up in outline order in the new list.
  const moveAll = (status: string) => run({ type: 'tasks.moveToList', ids: leaves, status })

  return (
    <header
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(GROUP_DRAG_TYPE, parentId)
        e.dataTransfer.effectAllowed = 'move'
        dragging.group = { parentId, ids, row, cell }
        dragging.height = (e.currentTarget.parentElement as HTMLElement | null)?.offsetHeight ?? 60
        onDragStart(parentId, cell)
      }}
      onDragEnd={() => {
        dragging.group = null
        onDragEnd()
      }}
      title={`${[...path, t.title].join(' › ')}\nDrag to move these ${ids.length} ${ids.length === 1 ? 'card' : 'cards'} together`}
      className="group/gh flex h-7 cursor-grab items-center gap-1 pr-0.5 pl-0.5 active:cursor-grabbing"
    >
      {!readOnly && <DotsSixVertical weight="bold" className="size-3.5 shrink-0 text-muted-foreground/70" />}
      <span className="flex min-w-0 items-baseline gap-1">
        {path.length > 0 && <span className="max-w-24 shrink truncate text-[11px] text-muted-foreground">{path.join(' › ')} ›</span>}
        <button
          onClick={() => openTask(parentId)}
          className="min-w-0 shrink-0 truncate text-left text-xs font-semibold text-foreground/85 hover:underline"
        >
          {t.title}
        </button>
      </span>
      <span className="ml-auto shrink-0 pl-1 text-[11px] text-muted-foreground tabular-nums" title="Subtasks done, in all lists">
        {idx.subDone.get(parentId)}/{idx.subTotal.get(parentId)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={`${t.title} options`}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 group-hover/gh:opacity-100 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <DotsThree weight="bold" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => openTask(parentId)}>
            <ArrowSquareOut /> Open “{t.title}”
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => focus(parentId)}>
            <Crosshair /> Focus on its subtasks
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Move all {leaves.length} {leaves.length === 1 ? 'subtask' : 'subtasks'} to
          </DropdownMenuLabel>
          {data.columns
            .filter((c) => !hidden.has(c.id))
            .map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => moveAll(c.id)}>
                <StatusDot category={c.category} color={c.color} /> {c.name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
