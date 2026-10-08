import { Gauge } from '@phosphor-icons/react'
import { whensOf } from '@kanbanto/model/rules'
import { useBoard } from '@/app/board-context'
import { useLimits } from '@/app/use-limits'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { RulesList } from './RulesList'

/**
 * Above every view, on a board that has rules: how many limits are over, and behind it all of the board's rules,
 * the limits with where each stands and the ones that tell people with who they tell. This is where a limit that
 * isn't about one list shows (two lists, the whole board), where limits are seen at all in a view that has no list
 * headers (the Outline, the Timeline, a Board whose columns are parent cards), and where anyone finds the rules that
 * tell them, to switch one off.
 */
export function RulesButton() {
  const { data } = useBoard()
  const states = useLimits()
  if (!states.length && !whensOf(data.rules).length) return null
  const over = states.filter((s) => s.standing === 'over').length
  const broken = states.filter((s) => s.problem).length
  const said = over ? `Rules: ${over} ${over === 1 ? 'limit' : 'limits'} over` : 'Rules'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 max-sm:px-2" title={said} aria-label={said}>
          <Gauge />
          <span className="max-sm:hidden">Rules</span>
          {(over > 0 || broken > 0) && (
            <span
              className={cn(
                'grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold',
                over ? 'bg-destructive text-white' : 'bg-amber-500 text-white',
              )}
            >
              {over || '!'}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[calc(100dvh-7rem)] w-96 max-w-[calc(100vw-1.5rem)] overflow-y-auto">
        <RulesList compact />
      </PopoverContent>
    </Popover>
  )
}
