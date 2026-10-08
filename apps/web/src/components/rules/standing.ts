import { numberText } from '@kanbanto/model/fields'
import type { LimitStanding, RuleState } from '@kanbanto/model/rules'
import { useBoard } from '@/app/board-context'

/** How a standing looks: quiet while there's room, amber at the number, red past it. */
export const STANDING: Record<LimitStanding, string> = {
  ok: 'bg-foreground/8 text-muted-foreground',
  near: 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
  over: 'bg-destructive/15 text-destructive',
  under: 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
}
export const SAID: Record<LimitStanding, string> = { ok: 'There is room.', near: 'It is full.', over: 'It is over.', under: 'It is short.' }

/** What a limit adds up, as a pair: "4 / 3", "38 / 40 h". (The unit is said once, with the limit.) */
export function useAmounts(state: RuleState) {
  const { idx } = useBoard()
  const { rule } = state
  const def = rule.measure.by === 'field' ? idx.fields.get(rule.measure.field) : undefined
  const bare = (n: number) => (def ? numberText({ decimals: def.decimals }, n) : String(n))
  const most = rule.max ?? rule.min ?? 0
  return { bare, most: def ? numberText(def, most) : String(most), pair: (n: number) => `${bare(n)} / ${def ? numberText(def, most) : most}` }
}
