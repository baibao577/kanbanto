import { Tag } from '@phosphor-icons/react'
import { numberText, type FieldValue } from '@kanbanto/model/fields'
import { totalUnder } from '@kanbanto/model/totals'
import type { Task } from '@kanbanto/model/types'
import { useBoard } from '@/app/board-context'
import { FieldValueEditor } from '@/components/fields/FieldValue'
import { Section } from './Section'

/**
 * The board's own fields on a card (see model/fields.ts): the card's first section, a box for each in the board's
 * order, edited in place. Nothing when the board has none. `onChange` gets the fields that change (null clears one).
 * A number that adds up says what the card comes to with its subtasks, when that's more than its own.
 */
export function CustomFields({
  task,
  readOnly,
  onChange,
}: {
  task: Task
  readOnly: boolean
  onChange: (custom: Record<string, FieldValue | null>) => void
}) {
  const { data, idx } = useBoard()
  if (!data.fields.length) return null
  const parent = idx.childrenOf.has(task.id)
  const filled = data.fields.filter((f) => task.custom?.[f.id] !== undefined).length
  return (
    <Section
      icon={<Tag />}
      title="Fields"
      aside={
        <span className="text-xs text-muted-foreground tabular-nums">
          {filled} of {data.fields.length} filled in
        </span>
      }
    >
      {/* View only: every field shows its value but can't be changed. */}
      <fieldset disabled={readOnly} className="grid min-w-0 grid-cols-2 items-start gap-2 xl:grid-cols-3">
        {data.fields.map((f) => {
          const all = parent && f.type === 'number' && f.sum ? totalUnder(idx, f, task.id) : undefined
          return (
            <div key={f.id} className="min-w-0 rounded-lg bg-muted/50 px-1 pt-1.5 pb-1">
              <p className="truncate px-2 text-xs font-medium" title={f.name}>
                {f.name}
              </p>
              <FieldValueEditor field={f} value={task.custom?.[f.id]} taskId={task.id} onChange={(v) => onChange({ [f.id]: v })} />
              {all !== undefined && all !== task.custom?.[f.id] && (
                <p className="truncate px-2 pb-0.5 text-[11px] text-muted-foreground">{numberText(f, all)} with subtasks</p>
              )}
            </div>
          )
        })}
      </fieldset>
    </Section>
  )
}
