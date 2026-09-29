import { useBoard } from '@/app/board-context'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { statusCol } from '@kanbanto/model/indexer'
import { StatusDot, StatusPill } from './bits'

/** A status pill you can click to change the status. Parents that follow their subtasks show it read-only. */
export function StatusMenu({ id }: { id: string }) {
  const { data, idx, run, readOnly } = useBoard()
  const col = statusCol(idx, id)
  if (readOnly) return <StatusPill col={col} />
  if (data.board.mode === 'derived' && idx.childrenOf.has(id))
    return (
      <span title="Follows its subtasks">
        <StatusPill col={col} />
      </span>
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50" title="Change status">
        <StatusPill col={col} className="hover:brightness-95" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={col.id} onValueChange={(v) => run({ type: 'task.update', id, fields: { status: v } })}>
          {data.columns.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={c.id}>
              <StatusDot category={c.category} color={c.color} /> {c.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
