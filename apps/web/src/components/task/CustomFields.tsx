import { numberText, type FieldValue } from '@kanbanto/model/fields'
import { totalUnder } from '@kanbanto/model/totals'
import type { Task } from '@kanbanto/model/types'
import { useBoard } from '@/app/board-context'
import { FieldValueEditor } from '@/components/fields/FieldValue'

/**
 * The board's own fields on a card (see model/fields.ts): one row each, in the board's order, edited in place.
 * Nothing when the board has none. `onChange` gets the fields that change (null clears one). A number that adds up
 * says what the card comes to with its subtasks, when that's more than its own.
 */
export function CustomFields({ task, onChange }: { task: Task; onChange: (custom: Record<string, FieldValue | null>) => void }) {
  const { data, idx } = useBoard()
  if (!data.fields.length) return null
  const parent = idx.childrenOf.has(task.id)
  return (
    <div>
      {data.fields.map((f) => {
        const all = parent && f.type === 'number' && f.sum ? totalUnder(idx, f, task.id) : undefined
        return (
          <div key={f.id}>
            <p className="mb-0.5 px-2 text-xs font-medium text-muted-foreground">
              {f.name}
              {all !== undefined && all !== task.custom?.[f.id] && <span className="font-normal"> · {numberText(f, all)} with subtasks</span>}
            </p>
            <FieldValueEditor field={f} value={task.custom?.[f.id]} onChange={(v) => onChange({ [f.id]: v })} />
          </div>
        )
      })}
    </div>
  )
}
