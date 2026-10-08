import { CaretDown } from '@phosphor-icons/react'
import { stepsOf, type CardTemplate } from '@kanbanto/model/templates'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

/**
 * The arrow on an "add" button: the board's card templates, to start the card from one in place of typing it. It
 * sits against the button it belongs to (the two read as one), and is only drawn on a board that has templates.
 */
export function TemplateMenu({
  templates,
  onPick,
  align = 'start',
  className,
  onOpenChange,
}: {
  templates: readonly CardTemplate[]
  onPick: (template: CardTemplate) => void
  /** Told when the list opens and closes (a field beside it that closes when left stays open meanwhile). */
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'end'
  className?: string
}) {
  if (!templates.length) return null
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          aria-label="From a template"
          title="From a template"
          // (mousedown: the field beside it keeps what was typed, and doesn't close before the click lands.)
          onMouseDown={(e) => e.preventDefault()}
          className={cn('rounded-l-none border-l border-primary-foreground/30 px-1.5', className)}
        >
          <CaretDown weight="bold" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">From a template</DropdownMenuLabel>
        {templates.map((t) => {
          const steps = stepsOf(t)
          return (
            <DropdownMenuItem key={t.id} onSelect={() => onPick(t)}>
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              {steps > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {steps} {steps === 1 ? 'step' : 'steps'}
                </span>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
