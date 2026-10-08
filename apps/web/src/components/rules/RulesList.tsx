import { BellSimpleSlash, PencilSimple, Plus, Warning } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ASSIGNEE, describeRule, MAX_RULES, ruleProblem, toldBy, whensOf, type LimitRule, type RuleState, type WhenRule } from '@kanbanto/model/rules'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { useAuth } from '@/app/use-auth'
import { useLimits } from '@/app/use-limits'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { LimitChip } from './LimitChip'
import { LimitEditor } from './LimitEditor'
import { STANDING, useAmounts } from './standing'
import { TellEditor } from './TellEditor'

/** One limit: its name, what it says, and where it stands now (for each person, when it holds each by themselves). */
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
      {onEdit && <EditButton words={describeRule(rule, data)} onClick={onEdit} />}
    </li>
  )
}

const EditButton = ({ words, onClick }: { words: string; onClick: () => void }) => (
  <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-muted-foreground" aria-label={`Change: ${words}`} onClick={onClick}>
    <PencilSimple />
  </Button>
)

/** Who switched which rule off for themselves: yours, and for the board's owners everyone's (by rule). */
interface Mutes {
  mine: string[]
  all?: Record<string, { id: string; name: string }[]>
}

/**
 * One rule that tells people: its name, what it says, and for a person it tells, the switch that stops it telling
 * them. Owners see who switched it off.
 */
function TellRow({ rule, mutes, onMute, onEdit }: { rule: WhenRule; mutes: Mutes | null; onMute?: (muted: boolean) => void; onEdit?: () => void }) {
  const { data, idx } = useBoard()
  const problem = ruleProblem(idx, rule, data.labels)
  const words = describeRule(rule, data)
  const off = mutes?.mine.includes(rule.id) ?? false
  const others = (mutes?.all?.[rule.id] ?? []).filter((p) => idx.members.has(p.id))
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        {rule.name && <p className="truncate text-sm font-medium">{rule.name}</p>}
        <p className={cn('text-sm', rule.name && 'text-muted-foreground')}>{words}</p>
        {problem && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <Warning className="mt-0.5 size-3.5 shrink-0" /> This rule can’t work. {problem}
          </p>
        )}
        {/* Under the sentence, not beside it: in the popover there is no room for both. */}
        {onMute && !problem && (
          <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={!off} disabled={!mutes} onCheckedChange={(told) => onMute(!told)} aria-label={`Tell me: ${words}`} />
            {off ? 'Off for you' : 'Tells you'}
          </label>
        )}
        {others.length > 0 && (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
            <BellSimpleSlash className="mt-0.5 size-3.5 shrink-0" /> Switched off by {others.map((p) => p.name.split(' ')[0]).join(', ')}
          </p>
        )}
      </div>
      {onEdit && <EditButton words={words} onClick={onEdit} />}
    </li>
  )
}

/**
 * The board's rules. Its limits, each with where it stands now, whatever it is about (a list, several, the whole
 * board), and its rules that tell people when a card arrives somewhere or leaves, each with who it tells; the ones
 * that can't be worked out say so. Its owners make, change and remove them from here, and anyone a rule tells can
 * switch that off for themselves. In Board settings → Rules, and behind the Rules button above the views.
 */
export function RulesList({ compact }: { /** In the popover: no explanations, and only the headings it needs. */ compact?: boolean }) {
  const { data, access } = useBoard()
  const { user } = useAuth()
  const states = useLimits()
  const tells = whensOf(data.rules)
  const owner = access.role === 'owner'
  const full = states.length + tells.length >= MAX_RULES
  const [editing, setEditing] = useState<LimitRule | WhenRule | 'limit' | 'when' | null>(null)
  // Who switched what off isn't part of the board (it is each person's own business): asked for here.
  const member = !!user && access.via !== 'public'
  const [mutes, setMutes] = useState<Mutes | null>(null)
  const boardId = data.board.id
  const asks = member && tells.length > 0
  useEffect(() => {
    if (!asks) return
    let gone = false
    api<Mutes>('GET', `/boards/${boardId}/rules/mutes`).then(
      (m) => !gone && setMutes(m),
      () => {},
    )
    return () => void (gone = true)
  }, [boardId, asks])
  const mute = (rule: WhenRule, muted: boolean) => {
    const was = mutes
    const mine = (mutes?.mine ?? []).filter((id) => id !== rule.id)
    const me = { id: user!.id, name: user!.name }
    const of = (mutes?.all?.[rule.id] ?? []).filter((p) => p.id !== me.id)
    setMutes({ mine: muted ? [...mine, rule.id] : mine, ...(mutes?.all && { all: { ...mutes.all, [rule.id]: muted ? [...of, me] : of } }) })
    api('PUT', `/boards/${boardId}/rules/${rule.id}/mute`, { muted }).then(
      () => toast(muted ? 'This rule no longer tells you.' : 'This rule tells you again.'),
      (e) => {
        setMutes(was)
        toast.error(errorMessage(e))
      },
    )
  }
  // (It can tell you when you're one of the people ticked, or when it tells whoever a card is assigned to.)
  const tellsMe = (rule: WhenRule) => member && toldBy(rule).some((id) => id === user!.id || id === ASSIGNEE)
  const both = states.length > 0 && tells.length > 0

  return (
    <div className={cn(!compact && 'space-y-6')}>
      {(!compact || states.length > 0 || !tells.length) && (
        <section>
          {(!compact || both) && <h3 className={cn('font-semibold', compact ? 'text-xs text-muted-foreground' : 'text-sm')}>Limits</h3>}
          {!compact && (
            <p className="mt-1 text-sm text-muted-foreground">
              A limit says how much of something there may be: cards in a list, hours of a number field, cards for each person. The board shows where
              each stands, the same to everyone, and nothing is refused.
            </p>
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
            <Button variant="outline" size="sm" className="mt-3" disabled={full} onClick={() => setEditing('limit')}>
              <Plus /> New limit
            </Button>
          )}
        </section>
      )}
      {(!compact || tells.length > 0) && (
        <section className={cn(compact && both && 'mt-4 border-t pt-3')}>
          {(!compact || both) && (
            <h3 className={cn('font-semibold', compact ? 'text-xs text-muted-foreground' : 'text-sm')}>When this, tell someone</h3>
          )}
          {!compact && (
            <p className="mt-1 text-sm text-muted-foreground">
              A rule that tells people when a card arrives somewhere, or leaves: a new quote to send, an order ready to bake. They get a line under
              their bell, and anyone can switch a rule off for themselves.
            </p>
          )}
          {tells.length > 0 ? (
            <ul className={cn('divide-y', !compact && 'mt-3')}>
              {tells.map((rule) => (
                <TellRow
                  key={rule.id}
                  rule={rule}
                  mutes={mutes}
                  onMute={tellsMe(rule) ? (muted) => mute(rule, muted) : undefined}
                  onEdit={owner ? () => setEditing(rule) : undefined}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
              No rules yet.{owner ? ' Make one here, or from a list’s “…” menu.' : ' The board’s owners can make them.'}
            </p>
          )}
          {owner && (
            <Button variant="outline" size="sm" className="mt-3" disabled={full} onClick={() => setEditing('when')}>
              <Plus /> New rule
            </Button>
          )}
        </section>
      )}
      {owner && full && <p className="mt-2 text-xs text-muted-foreground">A board can have up to {MAX_RULES} rules in all.</p>}
      {editing &&
        (editing === 'when' || (editing !== 'limit' && editing.kind === 'when') ? (
          <TellEditor rule={editing === 'when' ? undefined : editing} onClose={() => setEditing(null)} />
        ) : (
          <LimitEditor rule={editing === 'limit' ? undefined : editing} onClose={() => setEditing(null)} />
        ))}
    </div>
  )
}
