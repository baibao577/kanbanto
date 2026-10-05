import { FunnelSimple, Plus, X } from '@phosphor-icons/react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { Avatar, LabelChip, PriorityIcon, StatusDot } from '@/components/common/bits'
import { LinkChip } from '@/components/fields/LinkValue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AGE_SHOWN } from '@kanbanto/model/age'
import { linksOf, tidyFilter, type BoardField, type FieldFilter, type FieldType } from '@kanbanto/model/fields'
import { filterCount, type TableFilter } from '@kanbanto/model/table'
import { PRIORITIES, PRIORITY_LABEL } from '@kanbanto/model/types'

// "Recently" ends where a card starts showing its age (Display → Card age).
const CHANGED_DEFAULT = AGE_SHOWN
const IDLE_DEFAULT = 7

const toggleIn = (list: string[] | undefined, v: string) => {
  const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]
  return next.length ? next : undefined
}

/**
 * "Filter" popover, shared by every tab: recent or no activity, status, people, priority, labels, due date, and the
 * board's own fields.
 */
export function FilterMenu() {
  const { data, prefs, setPrefs } = useBoard()
  const f = prefs.filter
  const set = (patch: Partial<TableFilter>) => setPrefs({ type: 'setFilter', filter: { ...f, ...patch } })
  const n = filterCount(f)
  // Fields being filtered by show their controls; the others wait in a row of names. One that's just been picked,
  // or emptied while typing, stays open until the menu closes.
  const [opened, setOpened] = useState<string[]>([])
  const setField = (def: BoardField, next: FieldFilter | undefined) => {
    const all = { ...f.fields, [def.id]: next && tidyFilter(def, next) }
    const kept = data.fields.flatMap((d) => (all[d.id] ? [[d.id, all[d.id]!] as const] : []))
    set({ fields: kept.length ? Object.fromEntries(kept) : undefined })
    setOpened((o) => (next === undefined ? o.filter((id) => id !== def.id) : o.includes(def.id) ? o : [...o, def.id]))
  }
  const shown = data.fields.filter((d) => f.fields?.[d.id] || opened.includes(d.id))
  const waiting = data.fields.filter((d) => !shown.includes(d))

  return (
    <Popover onOpenChange={(open) => !open && setOpened([])}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 max-sm:px-2" title="Filter">
          <FunnelSimple />
          <span className="max-sm:hidden">Filter</span>
          {n > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {n}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[calc(100dvh-7rem)] w-80 overflow-y-auto p-0">
        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="filter-changed" className="cursor-pointer">
              <span className="block text-sm">Recently changed</span>
              <span className="block text-xs text-muted-foreground">Moved, edited or commented on (or its subtasks)</span>
            </label>
            <Switch id="filter-changed" checked={!!f.changed} onCheckedChange={(on) => set({ changed: on ? CHANGED_DEFAULT : undefined })} />
          </div>
          {!!f.changed && (
            <Days label="Days since the last change" value={f.changed} onChange={(n) => set({ changed: n })} before="In the last" after="days" />
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <label htmlFor="filter-idle" className="cursor-pointer">
              <span className="block text-sm">No activity lately</span>
              <span className="block text-xs text-muted-foreground">Not moved, edited or commented on (nor its subtasks)</span>
            </label>
            <Switch id="filter-idle" checked={!!f.idle} onCheckedChange={(on) => set({ idle: on ? IDLE_DEFAULT : undefined })} />
          </div>
          {!!f.idle && <Days label="Days without activity" value={f.idle} onChange={(n) => set({ idle: n })} before="For" after="days or more" />}
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

        {data.fields.length > 0 && (
          <Section title="Fields">
            {shown.map((d) => (
              <div key={d.id} className="pb-2">
                <div className="flex h-7 items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{d.name}</span>
                  <button
                    aria-label={`Stop filtering by ${d.name}`}
                    onClick={() => setField(d, undefined)}
                    className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                <FieldFilterControl field={d} value={f.fields?.[d.id] ?? {}} onChange={(next) => setField(d, next)} />
              </div>
            ))}
            {waiting.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {waiting.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setOpened([...opened, d.id])}
                    aria-label={`Filter by ${d.name}`}
                    className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Plus className="size-3 shrink-0" />
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        )}

        {n > 0 && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setPrefs({ type: 'setFilter', filter: {} })
                  setOpened([])
                }}
              >
                Clear filters
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A number of days, typed into a sentence ("In the last 3 days"). */
function Days({
  label,
  value,
  onChange,
  before,
  after,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  before: string
  after: string
}) {
  return (
    <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
      {before}
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={365}
        aria-label={label}
        defaultValue={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value))
          if (n >= 1 && n <= 365) onChange(n)
        }}
        className="h-7 w-16 px-2 text-sm"
      />
      {after}
    </label>
  )
}

/** Any, or one of a few: the whole of a filter for a field of a kind that needs no more. */
function OneOf({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(v) => v && onChange(v)}
      aria-label={label}
      className="w-full"
    >
      {[['any', 'Any'], ...options].map(([key, text]) => (
        <ToggleGroupItem key={key} value={key} className="flex-1 text-xs">
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

type FilterControl = (p: { field: BoardField; value: FieldFilter; onChange: (next: FieldFilter | undefined) => void }) => ReactNode

/** Cards a filter by a card link offers at once. */
const MAX_LINKED = 50

/** A card link: tick from the cards the board's cards link to in this field (and the ones already ticked), or none. */
function LinkFilter({ field, value, onChange }: Parameters<FilterControl>[0]) {
  const { data, links } = useBoard()
  // (Named by title, so in the order they're found until titles arrive.)
  useSyncExternalStore(links.subscribeAll, links.getVersion)
  const refs = [...new Set([...(value.in ?? []).filter(Boolean), ...Object.values(data.tasks).flatMap((t) => linksOf(t.custom?.[field.id]))])]
    .sort((a, b) => (links.titleOf(a) ?? '~').localeCompare(links.titleOf(b) ?? '~'))
    .slice(0, MAX_LINKED)
  return (
    <>
      {refs.map((ref) => (
        <CheckRow key={ref} checked={!!value.in?.includes(ref)} onChange={() => onChange({ in: toggleIn(value.in, ref) })}>
          <LinkChip link={ref} plain />
        </CheckRow>
      ))}
      <CheckRow checked={!!value.in?.includes('')} onChange={() => onChange({ in: toggleIn(value.in, '') })}>
        <span className="text-muted-foreground">None linked</span>
      </CheckRow>
    </>
  )
}

/** A person field: tick from the board's people (and anyone already ticked who has left since), or no one. */
function PersonFilter({ value, onChange }: Parameters<FilterControl>[0]) {
  const { data } = useBoard()
  return (
    <>
      {data.members.map((m) => (
        <CheckRow key={m.id} checked={!!value.in?.includes(m.id)} onChange={() => onChange({ in: toggleIn(value.in, m.id) })}>
          <Avatar name={m.name} className="size-5 text-[9px]" /> {m.name}
        </CheckRow>
      ))}
      <CheckRow checked={!!value.in?.includes('')} onChange={() => onChange({ in: toggleIn(value.in, '') })}>
        <span className="text-muted-foreground">No one</span>
      </CheckRow>
    </>
  )
}

/** What each kind of field can be filtered by (the rules themselves are in model/fields.ts). */
const FIELD_FILTER: Record<FieldType, FilterControl> = {
  link: (p) => <LinkFilter {...p} />,
  person: (p) => <PersonFilter {...p} />,
  choice: ({ field, value, onChange }) => (
    <>
      {(field.options ?? [])
        .filter((o) => !o.archived || value.in?.includes(o.id))
        .map((o) => (
          <CheckRow key={o.id} checked={!!value.in?.includes(o.id)} onChange={() => onChange({ in: toggleIn(value.in, o.id) })}>
            <LabelChip label={o} />
          </CheckRow>
        ))}
      <CheckRow checked={!!value.in?.includes('')} onChange={() => onChange({ in: toggleIn(value.in, '') })}>
        <span className="text-muted-foreground">None picked</span>
      </CheckRow>
    </>
  ),
  checkbox: ({ field, value, onChange }) => (
    <OneOf
      label={field.name}
      value={value.checked === undefined ? 'any' : value.checked ? 'yes' : 'no'}
      options={[
        ['yes', 'Yes'],
        ['no', 'No'],
      ]}
      onChange={(v) => onChange(v === 'any' ? undefined : { checked: v === 'yes' })}
    />
  ),
  text: ({ field, value, onChange }) => (
    <OneOf
      label={field.name}
      value={value.has === undefined ? 'any' : value.has ? 'filled' : 'empty'}
      options={[
        ['filled', 'Filled in'],
        ['empty', 'Empty'],
      ]}
      onChange={(v) => onChange(v === 'any' ? undefined : { has: v === 'filled' })}
    />
  ),
  date: ({ field, value, onChange }) => (
    <OneOf
      label={field.name}
      value={value.date ?? 'any'}
      options={[
        ['past', 'Past'],
        ['week', 'Next 7 days'],
        ['none', 'No date'],
      ]}
      onChange={(v) => onChange(v === 'any' ? undefined : { date: v as FieldFilter['date'] })}
    />
  ),
  number: ({ field, value, onChange }) => {
    const bound = (part: 'min' | 'max', label: string) => (
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        aria-label={`${field.name}, ${label}`}
        disabled={value.has === false}
        defaultValue={value[part] ?? ''}
        onChange={(e) => {
          const n = e.target.value.trim() === '' ? undefined : Number(e.target.value)
          if (n === undefined || Number.isFinite(n)) onChange({ ...value, [part]: n })
        }}
        className="h-7 w-24 px-2 text-sm"
      />
    )
    return (
      <>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          From {bound('min', 'at least')} to {bound('max', 'at most')}
        </div>
        <CheckRow checked={value.has === false} onChange={() => onChange(value.has === false ? undefined : { has: false })}>
          <span className="text-muted-foreground">No number</span>
        </CheckRow>
      </>
    )
  },
}

function FieldFilterControl(p: { field: BoardField; value: FieldFilter; onChange: (next: FieldFilter | undefined) => void }) {
  return FIELD_FILTER[p.field.type](p)
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
