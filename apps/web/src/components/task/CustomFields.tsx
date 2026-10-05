import type { FieldValue } from '@kanbanto/model/fields'
import type { Task } from '@kanbanto/model/types'
import { useBoard } from '@/app/board-context'
import { FieldValueEditor } from '@/components/fields/FieldValue'

/**
 * The board's own fields on a card (see model/fields.ts): one row each, in the board's order, edited in place.
 * Nothing when the board has none. `onChange` gets the fields that change (null clears one).
 */
export function CustomFields({ task, onChange }: { task: Task; onChange: (custom: Record<string, FieldValue | null>) => void }) {
  const { data } = useBoard()
  if (!data.fields.length) return null
  return (
    <div>
      {data.fields.map((f) => (
        <div key={f.id}>
          <p className="mb-0.5 px-2 text-xs font-medium text-muted-foreground">{f.name}</p>
          <FieldValueEditor field={f} value={task.custom?.[f.id]} onChange={(v) => onChange({ [f.id]: v })} />
        </div>
      ))}
    </div>
  )
}
