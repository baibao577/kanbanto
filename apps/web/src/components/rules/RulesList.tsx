import { PencilSimple, Plus, Warning } from '@phosphor-icons/react'
import { useState } from 'react'
import { describeRule, MAX_RULES, type LimitRule, type RuleState } from '@kanbanto/model/rules'
import { useBoard } from '@/app/board-context'
import { useLimits } from '@/app/use-limits'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { LimitChip } from './LimitChip'
import { LimitEditor } from './LimitEditor'
import { STANDING, useAmounts } from './standing'

/** One rule: its name, what it says, and where it stands now (for each person, when it holds each by themselves). */
function Row({ state, onEdit }: { state: RuleState; onEdit?: () => void }) {
  const { data, idx } = useBoard()
  const { pair } = useAmounts(state)
  const { rule } = state
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        {rule.name && <p className="truncate text-sm font-medium">{rule.name}</p>}
        <p className={cn('text-sm', rule.name && 'text-muted-foreground')}>{describeRule(rule, data)}</p>
        {state.problem ? (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <Warning className="mt-0.5 size-3.5 shrink-0" /> This limit can’t be worked out. {state.problem}
          </p>
        ) : rule.per === 'person' ? (
          <p className="mt-1 flex flex-wrap gap-1">
            {state.groups.length ? (
              state.groups.map((g) => (
                <span key={g.person} className={cn('rounded-full px-1.5 text-[11px] leading-5 whitespace-nowrap tabular-nums', STANDING[g.standing])}>
                  <span className="font-medium">{idx.members.get(g.person)?.name.split(' ')[0]}</span> {pair(g.value)}
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">Nobody has any of these cards.</span>
            )}
          </p>
        ) : null}
      </div>
      {!state.problem && rule.per !== 'person' && <LimitChip state={state} className="mt-0.5" />}
      {onEdit && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-muted-foreground"
          aria-label={`Change: ${describeRule(rule, data)}`}
          onClick={onEdit}
        >
          <PencilSimple />
        </Button>
      )}
    </li>
  )
}

/**
 * The board's rules, each with where it stands now: every limit, whatever it is about (a list, several, the whole
 * board), and the ones that can't be worked out, said so. Its owners make, change and remove them from here.
 * In Board settings → Rules, and behind the Limits button above the views.
 */
export function RulesList({ compact }: { /** In the popover: no heading or explanation. */ compact?: boolean }) {
  const { access } = useBoard()
  const states = useLimits()
  const owner = access.role === 'owner'
  const [editing, setEditing] = useState<LimitRule | 'new' | null>(null)
  return (
    <div>
      {!compact && (
        <>
          <h3 className="text-sm font-semibold">Limits</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A limit says how much of something there may be: cards in a list, hours of a number field, cards for each person. The board shows where
            each stands, the same to everyone, and nothing is refused.
          </p>
        </>
      )}
      {states.length > 0 ? (
        <ul className={cn('divide-y', !compact && 'mt-3')}>
          {states.map((s) => (
            <Row key={s.rule.id} state={s} onEdit={owner ? () => setEditing(s.rule) : undefined} />
          ))}
        </ul>
      ) : (
        <p className={cn('text-sm text-muted-foreground', !compact && 'mt-3 rounded-lg border border-dashed px-3 py-4')}>
          No limits yet.{owner ? ' Make one here, or from a list’s “…” menu.' : ' The board’s owners can make them.'}
        </p>
      )}
      {owner && (
        <Button variant="outline" size="sm" className="mt-3" disabled={states.length >= MAX_RULES} onClick={() => setEditing('new')}>
          <Plus /> New limit
        </Button>
      )}
      {owner && states.length >= MAX_RULES && <p className="mt-2 text-xs text-muted-foreground">A board can have up to {MAX_RULES}.</p>}
      {editing && <LimitEditor rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
