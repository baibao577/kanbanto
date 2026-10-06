import { CalendarBlank, ChartBarHorizontal, SlidersHorizontal } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

/** Bars or Calendar: how the Timeline tab is drawn. Each board remembers which, on this device. */
export function TimelineSwitch() {
  const { prefs, setPrefs } = useBoard()
  const cfg = prefs.timeline ?? {}
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={cfg.as === 'calendar' ? 'calendar' : 'bars'}
      onValueChange={(v) => v && setPrefs({ type: 'setTimeline', config: { ...cfg, as: v === 'calendar' ? 'calendar' : undefined } })}
      aria-label="How the Timeline is drawn"
    >
      <ToggleGroupItem
        value="bars"
        aria-label="Bars"
        title="Bars: a row for each task, a bar from its start to its due date"
        className="gap-1.5 px-2.5"
      >
        <ChartBarHorizontal /> <span className="max-sm:hidden">Bars</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="calendar" aria-label="Calendar" title="Calendar: each day with the cards on it" className="gap-1.5 px-2.5">
        <CalendarBlank /> <span className="max-sm:hidden">Calendar</span>
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

/**
 * The Timeline's own row, over the bars or the calendar: the switch between them first, then what the one shown
 * needs (going to today, moving through the dates), and at the right how much time to show. The bar above it is the
 * same in every view (Presets, Filter, Display); what belongs to one view sits with that view.
 */
export function TimelineRow({ children, right, className }: { children?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-6', className)}>
      <TimelineSwitch />
      {children}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
}

/**
 * The Timeline's "Display", where the Board and the Outline have theirs: leaving done tasks out (the Outline follows
 * the same switch), and for the calendar, showing subtasks that have a date of their own.
 */
export function TimelineDisplayMenu({ calendar }: { calendar?: boolean }) {
  const { prefs, setPrefs } = useBoard()
  const hideDone = !!prefs.outline.hideDone
  const cfg = prefs.timeline ?? {}
  const subtasks = !!cfg.subtasks
  const changed = hideDone || (calendar && subtasks)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="relative h-8 gap-1.5 max-sm:px-2" title="Display">
          <SlidersHorizontal />
          <span className="max-sm:hidden">Display</span>
          {changed && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" aria-label="Changed" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <label className="flex cursor-pointer items-center justify-between gap-3 p-4">
          <span>
            <span className="block text-sm">Hide done tasks</span>
            <span className="block text-xs text-muted-foreground">On the Outline too. A line says how many are hidden.</span>
          </span>
          <Switch
            checked={hideDone}
            onCheckedChange={(on) => setPrefs({ type: 'setOutline', config: { ...prefs.outline, hideDone: on || undefined } })}
            aria-label="Hide done tasks"
          />
        </label>
        {calendar && (
          <>
            <Separator />
            <label className="flex cursor-pointer items-center justify-between gap-3 p-4">
              <span>
                <span className="block text-sm">Subtasks</span>
                <span className="block text-xs text-muted-foreground">Also show subtasks that have a date of their own, each on its day.</span>
              </span>
              <Switch
                checked={subtasks}
                onCheckedChange={(on) => setPrefs({ type: 'setTimeline', config: { ...cfg, subtasks: on } })}
                aria-label="Show subtasks that have a date of their own"
              />
            </label>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
