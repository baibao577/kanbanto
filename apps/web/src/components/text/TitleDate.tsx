import { Alarm, CalendarBlank, X } from '@phosphor-icons/react'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { localDay, moment, type useTitleDate } from './useTitleDate'

/** Under the field: "📅 Mon 5 Oct · 13:00 · due   ⏰ Remind   ✕". */
export function TitleDateChip({ state, className }: { state: ReturnType<typeof useTitleDate>; className?: string }) {
  const { when, remind, setRemind, ignore } = state
  if (!when) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-xs', className)}>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 text-foreground">
        <CalendarBlank className="size-3.5 text-primary" />
        Due {formatDay(when.timed ? moment(when.date) : localDay(when.date), true)}
      </span>
      <button
        type="button"
        aria-pressed={remind}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setRemind(!remind)}
        className={cn(
          'inline-flex h-6 items-center gap-1 rounded-full border px-2 transition-colors',
          remind ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
        )}
        title={when.timed ? 'Also remind at that time' : 'Also remind at 9:00 that day'}
      >
        <Alarm className="size-3.5" /> Remind
      </button>
      <button
        type="button"
        aria-label="Not a date: keep it in the title"
        title="Not a date: keep it in the title"
        onMouseDown={(e) => e.preventDefault()}
        onClick={ignore}
        className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
