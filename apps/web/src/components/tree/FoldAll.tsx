import { ArrowsInSimple, ArrowsOutSimple } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Expand all and Collapse all, small, in the heading of the column they fold: "Task", in the Outline and in the
 * Timeline's bars. `disabled`: while searching or filtering, when what is found is shown unfolded.
 */
export function FoldAll({
  onExpand,
  onCollapse,
  disabled,
  className,
}: {
  onExpand: () => void
  onCollapse: () => void
  disabled?: boolean
  className?: string
}) {
  const button = (label: string, onClick: () => void, icon: ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          // (Not the heading's own click or drag: sorting, moving the column.)
          onPointerDown={(e) => e.stopPropagation()}
          className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
  return (
    <span className={cn('flex shrink-0 items-center', className)}>
      {button('Expand all', onExpand, <ArrowsOutSimple className="size-3.5" />)}
      {button('Collapse all', onCollapse, <ArrowsInSimple className="size-3.5" />)}
    </span>
  )
}
