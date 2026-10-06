import { FunnelSimple, Plus, X } from '@phosphor-icons/react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { useAuth } from '@/app/use-auth'
import { Avatar, LabelChip, PriorityIcon, StatusDot } from '@/components/common/bits'
import { CheckRow, DateTestSelect, FieldCriteria } from '@/components/fields/FieldCriteria'
import { LinkChip } from '@/components/fields/LinkValue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { AGE_SHOWN } from '@kanbanto/model/age'
import { tidyDateTest } from '@kanbanto/model/dates'
import { linksOf, ME, tidyFilter, type BoardField, type FieldFilter } from '@kanbanto/model/fields'
import { dueAsTest, dueChoiceOf, filterCount, withDue, type TableFilter } from '@kanbanto/model/table'
import { PRIORITIES, PRIORITY_LABEL } from '@kanbanto/model/types'

// "Recently" ends where a card starts showing its age (Display → Card age).
const CHANGED_DEFAULT = AGE_SHOWN
const IDLE_DEFAULT = 7

const toggleIn = (list: string[] | undefined, v: string) => {
  const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]
  return next.length ? next : undefined
}

/**
 * "Filter" popover, shared by every tab: recent or no activity, status, people, priority, labels, the due and start
 * dates, and the board's own fields (what each can be asked is in FieldCriteria).
 */
export function FilterMenu() {
  const { data, prefs, setPrefs } = useBoard()
  const { user } = useAuth()
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
    // (Open, whatever it's set to now: a test that isn't whole yet, "contains" with nothing typed, is no filter.)
    setOpened((o) => (o.includes(def.id) ? o : [...o, def.id]))
  }
  const close = (def: BoardField) => {
    const { [def.id]: _gone, ...left } = f.fields ?? {}
    set({ fields: Object.keys(left).length ? left : undefined })
    setOpened((o) => o.filter((id) => id !== def.id))
  }
  const shown = data.fields.filter((d) => f.fields?.[d.id] || opened.includes(d.id))
  const waiting = data.fields.filter((d) => !shown.includes(d))
  const due = dueChoiceOf(f)

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
          {/* "Me" is whoever is looking: a filter saved with it is everyone's own. */}
          {user && (
            <CheckRow checked={!!f.assignees?.includes(ME)} onChange={() => set({ assignees: toggleIn(f.assignees, ME) })}>
              <Avatar name={user.name} className="size-5 text-[9px]" /> Me
            </CheckRow>
          )}
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
          <DateTestSelect label="Due" any="Any date" overdue value={due && dueAsTest(due)} onChange={(next) => set(withDue(next))} />
        </Section>

        <Section title="Start">
          <DateTestSelect
            label="Start"
            any="Any date"
            value={f.startIs}
            onChange={(next) => set({ startIs: typeof next === 'object' ? tidyDateTest(next) : undefined })}
          />
        </Section>

        {data.fields.length > 0 && (
          <Section title="Fields">
            {shown.map((d) => (
              <div key={d.id} className="pb-2">
                <div className="flex h-7 items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{d.name}</span>
                  <button
                    aria-label={`Stop filtering by ${d.name}`}
                    onClick={() => close(d)}
                    className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {d.type === 'link' ? (
                  <LinkCriteria field={d} value={f.fields?.[d.id] ?? {}} onChange={(next) => setField(d, next)} />
                ) : (
                  <FieldCriteria field={d} value={f.fields?.[d.id] ?? {}} onChange={(next) => setField(d, next)} people={data.members} />
                )}
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

/**
 * A card link: the cards to tick from are the ones this board's cards link to in the field (and the ones already
 * ticked), every one of them, found by typing part of a title.
 */
function LinkCriteria({ field, value, onChange }: { field: BoardField; value: FieldFilter; onChange: (next: FieldFilter | undefined) => void }) {
  const { data, links } = useBoard()
  // (Named by title, so in the order they're found until titles arrive: listed again as they do.)
  useSyncExternalStore(links.subscribeAll, links.getVersion)
  const refs = [
    ...new Set([
      ...[...(value.in ?? []), ...(value.notIn ?? [])].filter(Boolean),
      ...Object.values(data.tasks).flatMap((t) => linksOf(t.custom?.[field.id])),
    ]),
  ].sort((a, b) => (links.titleOf(a) ?? '~').localeCompare(links.titleOf(b) ?? '~'))
  return (
    <FieldCriteria
      field={field}
      value={value}
      onChange={onChange}
      links={{ refs, titleOf: links.titleOf, chip: (ref) => <LinkChip link={ref} plain /> }}
    />
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
