import { Plus } from '@phosphor-icons/react'
import { useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { Zone } from './useRowDrag'

/** The line showing where a row will land ("before" / "after"), starting at the level it will land at. */
export function DropLine({ zone, left }: { zone: Zone | undefined; left: number }) {
  if (zone !== 'before' && zone !== 'after') return null
  return (
    <div
      className="pointer-events-none absolute right-0 z-30 h-0.5 rounded-full bg-primary"
      style={{ left, [zone === 'before' ? 'top' : 'bottom']: -1 }}
    >
      <span className="absolute -top-[3px] -left-1 size-2 rounded-full border-2 border-primary bg-card" />
    </div>
  )
}

/** Inline field for typing new subtasks. Enter adds one and keeps the field open for the next. */
export function AddSubtaskRow({
  parentTitle,
  indent,
  onAdd,
  onClose,
  className,
  style,
  cellWidth,
}: {
  parentTitle: string
  /** Left padding, so the field lines up with the subtasks. */
  indent: number
  onAdd: (title: string) => void
  onClose: () => void
  className?: string
  style?: CSSProperties
  /**
   * Width of the pinned part holding the field. Needed when the row is much wider than the screen
   * (Timeline): a pinned cell as wide as its row can't stay pinned.
   */
  cellWidth?: number
}) {
  const [value, setValue] = useState('')
  return (
    <div role="row" className={cn('border-b bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))]', className)} style={style}>
      <div role="cell" className="sticky left-0 flex h-full items-center gap-2 pr-3" style={{ paddingLeft: indent, width: cellWidth }}>
        <Plus className="size-3.5 shrink-0 text-primary" />
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`New subtask of “${parentTitle}”, press Enter to add`}
          aria-label={`New subtask of ${parentTitle}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              onAdd(value.trim())
              setValue('')
            }
            if (e.key === 'Escape') onClose()
          }}
          onBlur={() => !value.trim() && onClose()}
          className="h-7 w-full max-w-md rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </div>
    </div>
  )
}
