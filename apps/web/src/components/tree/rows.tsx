import { Plus } from '@phosphor-icons/react'
import { useState, type CSSProperties } from 'react'
import { TitleDateChip } from '@/components/text/TitleDate'
import { useTitleDate } from '@/components/text/useTitleDate'
import { cn } from '@/lib/utils'
import type { TaskFields } from '@kanbanto/model/commands'
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
  prompt,
  indent,
  onAdd,
  onClose,
  className,
  style,
  cellWidth,
}: {
  parentTitle: string
  /** What the field is for, when it isn't a subtask of that card: "New task in “Doing”". */
  prompt?: string
  /** Left padding, so the field lines up with the subtasks. */
  indent: number
  /** With a time typed in the title: the fields it sets (due, maybe a reminder), taken out of the title. */
  onAdd: (title: string, fields?: TaskFields) => void
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
  const date = useTitleDate(value)
  return (
    <div role="row" className={cn('border-b bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))]', className)} style={style}>
      <div role="cell" className="sticky left-0 flex h-full items-center gap-2 pr-3" style={{ paddingLeft: indent, width: cellWidth }}>
        <Plus className="size-3.5 shrink-0 text-primary" />
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`${prompt ?? `New subtask of “${parentTitle}”`}, press Enter to add`}
          aria-label={prompt ?? `New subtask of ${parentTitle}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              const { title, fields } = date.apply(value.trim())
              onAdd(title, fields)
              setValue('')
              date.reset()
            }
            if (e.key === 'Escape') onClose()
          }}
          onBlur={() => !value.trim() && onClose()}
          className="h-7 w-full max-w-md rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <TitleDateChip state={date} className="shrink-0 flex-nowrap" />
      </div>
    </div>
  )
}
