import { Tray } from '@phosphor-icons/react'
import { useInbox } from '@/app/use-inbox'
import { Kbd } from '@/components/common/bits'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** In the top bar: opens your Inbox beside the page, and says how many cards wait in it. */
export function InboxButton() {
  const { boardId, here, count, open, show } = useInbox()
  if (!boardId) return null
  const on = open || here
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The bell's twin: the same plain button, its number a quiet badge (red is for what needs you). */}
        <button
          aria-label={count ? `Inbox (${count} ${count === 1 ? 'card' : 'cards'})` : 'Inbox'}
          aria-pressed={on}
          aria-disabled={here || undefined}
          onClick={() => !here && show(!open)}
          className={cn(
            'relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
            on && 'text-foreground',
            here && 'cursor-default',
          )}
        >
          <Tray weight={on ? 'fill' : 'regular'} className="size-5" />
          {count > 0 && (
            <span className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-muted-foreground px-1 text-[10px] leading-none font-semibold text-background">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {here ? (
          'This is your Inbox'
        ) : (
          <>
            Inbox <Kbd>I</Kbd>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
