import { memo } from 'react'
import type { BoardField, FieldValue } from '@kanbanto/model/fields'
import { FieldValueEditor, FieldValueText } from '@/components/fields/FieldValue'
import { cn } from '@/lib/utils'

/**
 * One of the board's fields in a row of the Outline, edited in place. Memoised, and it reads nothing from the board
 * itself: a change to one card re-draws that card's cells, not every editor in the table. `total`: what the card
 * and its subtasks add up to (number fields that add up), shown where the card has no number of its own.
 */
export const FieldCell = memo(function FieldCell({
  taskId,
  field,
  value,
  total,
  readOnly,
  first,
  height,
  onSet,
}: {
  taskId: string
  field: BoardField
  value: FieldValue | undefined
  total?: string
  readOnly: boolean
  first: boolean
  height: string
  onSet: (taskId: string, fieldId: string, value: FieldValue | null) => void
}) {
  return (
    // Pressing in a cell is for editing it, never for picking up the row.
    <div
      role="cell"
      data-no-drag
      title={total && value !== undefined ? `With its subtasks: ${total.replace(/^Σ /, '')}` : undefined}
      className={cn('flex min-w-0 items-center border-border/60 px-1', height, !first && 'border-l')}
    >
      {readOnly ? (
        value === undefined && total ? (
          <span className="truncate px-2 text-sm text-muted-foreground tabular-nums">{total}</span>
        ) : (
          <FieldValueText field={field} value={value} />
        )
      ) : (
        <div className="min-w-0 flex-1">
          <FieldValueEditor field={field} value={value} cell placeholder={total} taskId={taskId} onChange={(v) => onSet(taskId, field.id, v)} />
        </div>
      )}
    </div>
  )
})
