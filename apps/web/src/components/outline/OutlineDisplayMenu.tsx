import { SlidersHorizontal } from '@phosphor-icons/react'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { fieldKey, type FieldKey } from '@kanbanto/model/fields'
import { groupKeyOf, groupKeys, groupLabel, type GroupKey } from '@kanbanto/model/outlineGroups'
import { isExtraColumn, OUTLINE_COLUMNS, OUTLINE_EXTRA, type OutlineColumn, type Sort, type SortKey } from '@kanbanto/model/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** (A select can't have an empty value: this stands for not sorting, and for not grouping.) */
const NO_SORT = 'none'

const LABEL: Record<OutlineColumn, string> = {
  number: 'Number',
  status: 'Status',
  progress: 'Progress',
  assignee: 'Assignee',
  priority: 'Priority',
  start: 'Start',
  due: 'Due',
  labels: 'Labels',
  created: 'Created',
  updated: 'Updated',
}

/** The Outline's "Display": which columns show, and how tall rows are. Saved per board, like the board's display. */
export function OutlineDisplayMenu() {
  const { data, prefs, setPrefs, idx } = useBoard()
  const cfg = prefs.outline
  const group = groupKeyOf(cfg.group, idx.fields)
  const hidden = new Set<string>(cfg.hidden ?? [])
  // (Created and Updated are off until switched on; the others are on until switched off.)
  const extra = new Set<string>(cfg.extra ?? [])
  const shows = (c: OutlineColumn) => (isExtraColumn(c) ? extra.has(c) : !hidden.has(c))
  const changed = hidden.size > 0 || extra.size > 0 || !!cfg.hideFields || cfg.density === 'comfortable' || !!cfg.hideDone || !!cfg.order?.length
  // Always written in the same order (built-in columns, then fields by key), so a saved view compares equal to itself.
  const toggle = (c: OutlineColumn | FieldKey, on: boolean) => {
    if (isExtraColumn(c)) {
      const next = OUTLINE_EXTRA.filter((x) => (x === c ? on : extra.has(x)))
      return setPrefs({ type: 'setOutline', config: { ...cfg, extra: next.length ? next : undefined } })
    }
    const all: (OutlineColumn | FieldKey)[] = [...OUTLINE_COLUMNS, ...data.fields.map((f) => fieldKey(f.id)).sort()]
    const next = all.filter((x) => (x === c ? !on : hidden.has(x)))
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
      <PopoverContent align="end" className="max-h-(--radix-popover-content-available-height) w-64 overflow-y-auto p-0">
        {/* The rows under a heading for each list, person, priority, label, or value of a field (see OutlineView). */}
        <div className="space-y-2 p-4">
          <p className="text-xs font-medium text-muted-foreground">Group by</p>
          <Select
            value={group ?? NO_SORT}
            onValueChange={(v) => setPrefs({ type: 'setOutline', config: { ...cfg, group: v === NO_SORT ? undefined : (v as GroupKey) } })}
          >
            <SelectTrigger size="sm" className="w-full" aria-label="Group by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SORT}>Nothing</SelectItem>
              {groupKeys(data.fields).map((k) => (
                <SelectItem key={k} value={k}>
                  {groupLabel(k, idx.fields)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {group && (
            <p className="text-[11px] text-muted-foreground">
              Each task is under its own heading. The tasks above it come along in grey, to show where it belongs.
            </p>
          )}
        </div>
        <Separator />
        <div className="space-y-1.5 p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Columns</p>
          {OUTLINE_COLUMNS.map((c) => (
            <label key={c} className="flex h-7 cursor-pointer items-center gap-2.5 text-sm">
              <Checkbox checked={shows(c)} onCheckedChange={(on) => toggle(c, !!on)} />
              {LABEL[c]}
            </label>
          ))}
          <p className="pt-1 text-[11px] text-muted-foreground max-md:hidden">
            To move a column, drag its name in the table.{cfg.order?.length ? ' Reset puts them back in order.' : ''}
          </p>
          <p className="pt-1 text-[11px] text-muted-foreground md:hidden">
            On a phone, the Outline is a list: columns show as details under each task.
          </p>
        </div>
        {/* A phone has no column headings to click: the sort is chosen here. */}
        <div className="md:hidden">
          <Separator />
          <div className="space-y-2 p-4">
            <p className="text-xs font-medium text-muted-foreground">Sort by</p>
            <Select
              value={cfg.sort?.key ?? NO_SORT}
              onValueChange={(v) =>
                setPrefs({
                  type: 'setOutline',
                  config: { ...cfg, sort: v === NO_SORT ? undefined : { key: v as SortKey, dir: cfg.sort?.dir ?? 'asc' } },
                })
              }
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SORT}>Your own order</SelectItem>
                <SelectItem value="title">Task</SelectItem>
                {OUTLINE_COLUMNS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {LABEL[c]}
                  </SelectItem>
                ))}
                {data.fields.map((f) => (
                  <SelectItem key={f.id} value={fieldKey(f.id)}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {cfg.sort && (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={cfg.sort.dir}
                onValueChange={(v) =>
                  v && cfg.sort && setPrefs({ type: 'setOutline', config: { ...cfg, sort: { ...cfg.sort, dir: v as Sort['dir'] } } })
                }
                className="w-full"
              >
                <ToggleGroupItem value="asc" className="flex-1 text-xs">
                  ↑ Ascending
                </ToggleGroupItem>
                <ToggleGroupItem value="desc" className="flex-1 text-xs">
                  ↓ Descending
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        </div>
        {data.fields.length > 0 && (
          <>
            <Separator />
            <div className="space-y-1.5 p-4">
              <label className="mb-2 flex cursor-pointer items-center justify-between gap-3">
                <span className="text-xs font-medium text-muted-foreground">Fields</span>
                <Switch
                  checked={!cfg.hideFields}
                  onCheckedChange={(on) => setPrefs({ type: 'setOutline', config: { ...cfg, hideFields: on ? undefined : true } })}
                  aria-label="Show the board’s fields as columns"
                />
              </label>
              {data.fields.map((f) => (
                <label key={f.id} className={cn('flex h-7 items-center gap-2.5 text-sm', cfg.hideFields ? 'opacity-50' : 'cursor-pointer')}>
                  <Checkbox
                    checked={!cfg.hideFields && !hidden.has(fieldKey(f.id))}
                    disabled={!!cfg.hideFields}
                    onCheckedChange={(on) => toggle(fieldKey(f.id), !!on)}
                  />
                  <span className="truncate">{f.name}</span>
                </label>
              ))}
            </div>
          </>
        )}
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
        <Separator />
        <label className="flex cursor-pointer items-center justify-between gap-3 p-4">
          <span>
            <span className="block text-sm">Hide done tasks</span>
            <span className="block text-xs text-muted-foreground">On the Timeline too. A line says how many are hidden.</span>
          </span>
          <Switch
            checked={!!cfg.hideDone}
            onCheckedChange={(on) => setPrefs({ type: 'setOutline', config: { ...cfg, hideDone: on || undefined } })}
          />
        </label>
        {changed && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() =>
                  setPrefs({
                    type: 'setOutline',
                    config: {
                      ...cfg,
                      hidden: undefined,
                      extra: undefined,
                      hideFields: undefined,
                      density: undefined,
                      hideDone: undefined,
                      order: undefined,
                    },
                  })
                }
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
