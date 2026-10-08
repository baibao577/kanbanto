import { Warning } from '@phosphor-icons/react'
import { describeRule, isPlainCount, shortName, type RuleState } from '@kanbanto/model/rules'
import { useBoard } from '@/app/board-context'
import { cn } from '@/lib/utils'
import { SAID, STANDING, useAmounts } from './standing'

/**
 * A limit where it shows: how much there is against how much there may be ("4 / 3", "38 / 40 h"), or for a limit
 * that holds each person by themselves, the number each may have ("2 each"). `named`: with a few words for the rule
 * before its numbers ("Roofing crew 2 / 1"). Point at it for the rule in full.
 */
export function LimitChip({ state, named, className }: { state: RuleState; named?: boolean; className?: string }) {
  const { data } = useBoard()
  const { pair, most } = useAmounts(state)
  const words = describeRule(state.rule, data)
  const name = named ? shortName(state.rule, data) : ''
  if (state.problem)
    return (
      <span
        title={`${words}\nThis limit can’t be worked out. ${state.problem}`}
        className={cn('inline-flex max-w-full items-center gap-1 rounded-full px-1.5 text-[11px] leading-5', STANDING.ok, className)}
      >
        <Warning className="size-3 shrink-0" /> <span className="truncate">{name || 'limit'}</span>
      </span>
    )
  return (
    <span
      title={`${words}\n${SAID[state.standing]}`}
      aria-label={`${words}. ${SAID[state.standing]}`}
      className={cn(
        'max-w-full shrink-0 truncate rounded-full px-1.5 text-[11px] leading-5 font-medium whitespace-nowrap tabular-nums',
        STANDING[state.standing],
        className,
      )}
    >
      {name && <span className="font-normal">{name} </span>}
      {state.rule.per === 'person' ? `${most} each` : pair(state.groups[0].value)}
    </span>
  )
}

/** For a limit that holds each person by themselves: who has how much, the fullest first. */
function People({ state }: { state: RuleState }) {
  const { idx } = useBoard()
  const { pair } = useAmounts(state)
  return (
    <>
      {state.groups.map((g) => (
        <span key={g.person} className={cn('rounded-full px-1.5 text-[11px] leading-5 whitespace-nowrap tabular-nums', STANDING[g.standing])}>
          <span className="font-medium">{idx.members.get(g.person)?.name.split(' ')[0]}</span> {pair(g.value)}
        </span>
      ))}
    </>
  )
}

/**
 * Under a list's header: what doesn't fit beside its name. Each limit that needs words with its numbers (a field
 * added up, a condition, a name of its own: "Crew hours 166 / 160 h", "Roofing crew 2 / 1"), and for a limit that
 * holds each person by themselves, who has how much. A plain count stays in the header (see `isPlainCount`).
 */
export function LimitLines({ limits }: { limits: RuleState[] }) {
  const worded = limits.filter((s) => !isPlainCount(s.rule))
  const people = limits.filter((s) => !s.problem && s.rule.per === 'person' && s.groups.length)
  if (!worded.length && !people.length) return null
  return (
    <div className="space-y-1 px-3 pb-1.5">
      {worded.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {worded.map((s) => (
            <LimitChip key={s.rule.id} state={s} named />
          ))}
        </p>
      )}
      {people.map((s) => (
        <p key={s.rule.id} className="flex flex-wrap gap-1">
          <People state={s} />
        </p>
      ))}
    </div>
  )
}
