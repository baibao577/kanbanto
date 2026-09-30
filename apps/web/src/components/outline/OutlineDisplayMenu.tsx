import { SlidersHorizontal } from '@phosphor-icons/react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { OUTLINE_COLUMNS, type OutlineColumn } from '@kanbanto/model/table'

const LABEL: Record<OutlineColumn, string> = {
  status: 'Status',
  progress: 'Progress',
  assignee: 'Assignee',
  priority: 'Priority',
  start: 'Start',
  due: 'Due',
  labels: 'Labels',
}

/** The Outline's "Display": which columns show, and how tall rows are. Saved per board, like the board's display. */
export function OutlineDisplayMenu() {
  const { prefs, setPrefs } = useBoard()
  const cfg = prefs.outline
  const hidden = new Set(cfg.hidden ?? [])
  const changed = hidden.size > 0 || cfg.density === 'comfortable'
  const toggle = (c: OutlineColumn, on: boolean) => {
    const next = OUTLINE_COLUMNS.filter((x) => (x === c ? !on : hidden.has(x)))
    setPrefs({ type: 'setOutline', config: { ...cfg, hidden: next.length ? next : undefined } })
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="relative h-8 gap-1.5 max-sm:px-2" title="Display">
          <SlidersHorizontal />
          <span className="max-sm:hidden">Display</span>
          {changed && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" aria-label="Changed" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="space-y-1.5 p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Columns</p>
          {OUTLINE_COLUMNS.map((c) => (
            <label key={c} className="flex h-7 cursor-pointer items-center gap-2.5 text-sm">
              <Checkbox checked={!hidden.has(c)} onCheckedChange={(on) => toggle(c, !!on)} />
              {LABEL[c]}
            </label>
          ))}
          <p className="pt-1 text-[11px] text-muted-foreground md:hidden">
            On a phone, the Outline is a list: columns show as details under each task.
          </p>
        </div>
        <Separator />
        <div className="space-y-2 p-4">
          <p className="text-xs font-medium text-muted-foreground">Rows</p>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={cfg.density ?? 'compact'}
            onValueChange={(v) => v && setPrefs({ type: 'setOutline', config: { ...cfg, density: v === 'comfortable' ? 'comfortable' : undefined } })}
            className="w-full"
          >
            <ToggleGroupItem value="comfortable" className="flex-1 text-xs">
              Comfortable
            </ToggleGroupItem>
            <ToggleGroupItem value="compact" className="flex-1 text-xs">
              Compact
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {changed && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setPrefs({ type: 'setOutline', config: { ...cfg, hidden: undefined, density: undefined } })}
              >
                Reset
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
