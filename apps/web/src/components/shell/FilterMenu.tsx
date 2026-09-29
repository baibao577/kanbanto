import { FunnelSimple } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar, LabelChip, PriorityIcon, StatusDot } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { filterCount, type TableFilter } from '@kanbanto/model/table'
import { PRIORITIES, PRIORITY_LABEL } from '@kanbanto/model/types'

const toggleIn = (list: string[] | undefined, v: string) => {
  const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]
  return next.length ? next : undefined
}

/** "Filter" popover, shared by every tab: status, people, priority, labels, due date and "ready to start". */
export function FilterMenu() {
  const { data, prefs, setPrefs } = useBoard()
  const f = prefs.filter
  const set = (patch: Partial<TableFilter>) => setPrefs({ type: 'setFilter', filter: { ...f, ...patch } })
  const n = filterCount(f)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <FunnelSimple />
          Filter
          {n > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {n}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[calc(100dvh-7rem)] w-80 overflow-y-auto p-0">
        <div className="p-4">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-sm">Only tasks ready to start</span>
              <span className="block text-xs text-muted-foreground">Not started, no subtasks, not waiting on anything</span>
            </span>
            <Switch checked={!!f.upNext} onCheckedChange={(on) => set({ upNext: on || undefined })} />
          </label>
        </div>
        <Separator />

        <Section title="Status">
          {data.columns.map((c) => (
            <CheckRow key={c.id} checked={!!f.statuses?.includes(c.id)} onChange={() => set({ statuses: toggleIn(f.statuses, c.id) })}>
              <StatusDot category={c.category} color={c.color} /> {c.name}
            </CheckRow>
          ))}
        </Section>

        <Section title="Assignee">
          {data.members.map((m) => (
            <CheckRow key={m.id} checked={!!f.assignees?.includes(m.id)} onChange={() => set({ assignees: toggleIn(f.assignees, m.id) })}>
              <Avatar name={m.name} className="size-5 text-[9px]" /> {m.name}
            </CheckRow>
          ))}
          <CheckRow checked={!!f.assignees?.includes('')} onChange={() => set({ assignees: toggleIn(f.assignees, '') })}>
            <span className="text-muted-foreground">No one assigned</span>
          </CheckRow>
        </Section>

        <Section title="Priority">
          {PRIORITIES.map((p) => (
            <CheckRow
              key={p}
              checked={!!f.priorities?.includes(p)}
              onChange={() => set({ priorities: toggleIn(f.priorities, p) as TableFilter['priorities'] })}
            >
              <PriorityIcon priority={p} /> {PRIORITY_LABEL[p]}
            </CheckRow>
          ))}
          <CheckRow
            checked={!!f.priorities?.includes('')}
            onChange={() => set({ priorities: toggleIn(f.priorities, '') as TableFilter['priorities'] })}
          >
            <span className="text-muted-foreground">No priority</span>
          </CheckRow>
        </Section>

        {data.labels.length > 0 && (
          <Section title="Labels">
            {data.labels.map((l) => (
              <CheckRow key={l.id} checked={!!f.labels?.includes(l.id)} onChange={() => set({ labels: toggleIn(f.labels, l.id) })}>
                <LabelChip label={l} />
              </CheckRow>
            ))}
          </Section>
        )}

        <Section title="Due">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={f.due ?? 'any'}
            onValueChange={(v) => v && set({ due: v === 'any' ? undefined : (v as TableFilter['due']) })}
            className="w-full"
          >
            <ToggleGroupItem value="any" className="flex-1 text-xs">
              Any
            </ToggleGroupItem>
            <ToggleGroupItem value="overdue" className="flex-1 text-xs">
              Overdue
            </ToggleGroupItem>
            <ToggleGroupItem value="week" className="flex-1 text-xs">
              This week
            </ToggleGroupItem>
            <ToggleGroupItem value="none" className="flex-1 text-xs">
              No date
            </ToggleGroupItem>
          </ToggleGroup>
        </Section>

        {n > 0 && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPrefs({ type: 'setFilter', filter: {} })}>
                Clear filters
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 border-b p-4 last:border-b-0">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2.5 text-sm">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
    </label>
  )
}
