import { Gauge } from '@phosphor-icons/react'
import { useLimits } from '@/app/use-limits'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { RulesList } from './RulesList'

/**
 * Above every view, on a board that has limits: how many are over, and behind it all of them with where each
 * stands. This is where a limit that isn't about one list shows (two lists, the whole board), and where limits are
 * seen at all in a view that has no list headers (the Outline, the Timeline, a Board whose columns are parent cards).
 */
export function LimitsButton() {
  const states = useLimits()
  if (!states.length) return null
  const over = states.filter((s) => s.standing === 'over').length
  const broken = states.filter((s) => s.problem).length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 max-sm:px-2"
          title={over ? `Limits: ${over} over` : 'Limits'}
          aria-label={over ? `Limits: ${over} over` : 'Limits'}
        >
          <Gauge />
          <span className="max-sm:hidden">Limits</span>
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
