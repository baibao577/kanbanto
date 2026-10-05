import { CalendarBlank, CaretDown, FunnelSimple } from '@phosphor-icons/react'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import type { BoardSummary, WorkspaceSummary } from '@kanbanto/model/api'
import { filterFromText, filterToText, type FieldDef, type FieldFilter } from '@kanbanto/model/fields'
import { CARD_DATES, CARD_DATE_LABEL, CARD_RANGES, CARD_RANGE_LABEL, type CardState } from '@kanbanto/model/search'
import { PRIORITIES, PRIORITY_LABEL, type Priority } from '@kanbanto/model/types'
import { BoardDot, LabelChip, PriorityIcon } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { STATUSES, statusOf, whenWords, withStatus, type Search, type StatusChoice } from './search'

const Calendar = lazy(() => import('@/components/ui/calendar').then((m) => ({ default: m.Calendar })))

const ANY = '__any'
const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dateOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * The Search cards page's filters: where (a board, or a place's boards), status, who, when (which date, in which
 * range) and the rest under More. Each shows what it's set to; changing one changes the address.
 */
export function CardsFilters({
  search,
  set,
  boards,
  workspaces,
  people,
  labels,
  fields,
  field,
  meId,
}: {
  search: Search
  set: (patch: Partial<Search>) => void
  boards: BoardSummary[]
  workspaces: WorkspaceSummary[]
  /** The people, label names and fields of the boards searched (from the results). */
  people: { id: string; name: string }[]
  labels: string[]
  fields: FieldDef[]
  /** The field picked, when it's known: it may not be on the boards searched now. */
  field?: FieldDef
  meId: string
}) {
  const open = boards.filter((b) => !b.archivedAt || b.id === search.board)
  const where = search.board ? `board:${search.board}` : search.place ? `place:${search.place}` : ANY
  const hasShared = boards.some((b) => !b.workspaceId && b.role !== 'owner')
  const others = people.filter((p) => p.id !== meId)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={where}
        onValueChange={(v) => set({ board: v.startsWith('board:') ? v.slice(6) : undefined, place: v.startsWith('place:') ? v.slice(6) : undefined })}
      >
        <SelectTrigger size="sm" className="max-w-52" aria-label="Where">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All boards</SelectItem>
          <SelectGroup>
            <SelectLabel>Places</SelectLabel>
            <SelectItem value="place:personal">Personal</SelectItem>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={`place:${w.id}`}>
                {w.name}
              </SelectItem>
            ))}
            {hasShared && <SelectItem value="place:shared">Shared with you</SelectItem>}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Boards</SelectLabel>
            {open.map((b) => (
              <SelectItem key={b.id} value={`board:${b.id}`}>
                <BoardDot background={b.background} /> {b.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Select value={statusOf(search)} onValueChange={(v) => set(withStatus(v as StatusChoice))}>
        <SelectTrigger size="sm" aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={search.assignee ?? ANY} onValueChange={(v) => set({ assignee: v === ANY ? undefined : v })}>
        <SelectTrigger size="sm" className="max-w-44" aria-label="Assigned to">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Anyone</SelectItem>
          <SelectItem value="me">Me</SelectItem>
          <SelectItem value="none">No one</SelectItem>
          {others.length > 0 && <SelectSeparator />}
          {others.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          {/* Someone picked who isn't on the boards now searched still shows as picked. */}
          {search.assignee && !['me', 'none'].includes(search.assignee) && !others.some((p) => p.id === search.assignee) && (
            <SelectItem value={search.assignee}>Someone else</SelectItem>
          )}
        </SelectContent>
      </Select>

      <WhenMenu search={search} set={set} />
      <MoreMenu search={search} set={set} labels={labels} fields={fields} field={field} />
    </div>
  )
}

/** When: which of a card's dates, and the range it has to fall in (a named one, or two days from the calendar). */
function WhenMenu({ search, set }: { search: Search; set: (patch: Partial<Search>) => void }) {
  const [custom, setCustom] = useState(false)
  const on = !!search.when || !!search.range || !!search.from || !!search.to
  const days = !search.range && (!!search.from || !!search.to)
  const what = search.when ?? 'any'
  return (
    <Popover onOpenChange={(o) => !o && setCustom(false)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={`h-8 gap-1.5 font-normal ${on ? 'border-primary/50 text-foreground' : ''}`} aria-label="When">
          <CalendarBlank />
          {whenWords(search)}
          <CaretDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[calc(100dvh-7rem)] w-80 overflow-y-auto p-0">
        <Part title="Which date">
          <div className="flex flex-wrap gap-1.5">
            {CARD_DATES.map((d) => (
              <Pick key={d} on={what === d} onClick={() => set({ when: d === 'any' ? undefined : d })}>
                {CARD_DATE_LABEL[d]}
              </Pick>
            ))}
          </div>
          <p className="pt-1 text-xs text-muted-foreground">
            {what === 'any'
              ? 'Cards made, done, archived or last changed in the range.'
              : what === 'changed'
                ? 'By a card’s latest change (moved, edited or commented on): earlier changes aren’t kept.'
                : what === 'done'
                  ? 'By the day a card entered a done list.'
                  : what === 'created'
                    ? 'By the day a card was made.'
                    : 'By the day a card was archived.'}
          </p>
        </Part>
        <Part title="Range">
          <div className="flex flex-wrap gap-1.5">
            <Pick
              on={!search.range && !days && !custom}
              onClick={() => (setCustom(false), set({ range: undefined, from: undefined, to: undefined }))}
            >
              Any time
            </Pick>
            {CARD_RANGES.map((r) => (
              <Pick key={r} on={search.range === r && !custom} onClick={() => (setCustom(false), set({ range: r, from: undefined, to: undefined }))}>
                {CARD_RANGE_LABEL[r]}
              </Pick>
            ))}
            <Pick on={days || custom} onClick={() => setCustom(true)}>
              Pick days…
            </Pick>
          </div>
          {(days || custom) && (
            <Suspense fallback={<div className="h-72" />}>
              <Calendar
                mode="range"
                className="mx-auto p-0 pt-2"
                weekStartsOn={1}
                defaultMonth={search.from ? dateOf(search.from) : undefined}
                selected={days ? { from: search.from ? dateOf(search.from) : undefined, to: search.to ? dateOf(search.to) : undefined } : undefined}
                onSelect={(r) =>
                  set({ range: undefined, from: r?.from ? dayOf(r.from) : undefined, to: r?.to ? dayOf(r.to) : r?.from ? dayOf(r.from) : undefined })
                }
              />
            </Suspense>
          )}
        </Part>
      </PopoverContent>
    </Popover>
  )
}

const ARCHIVED: { state: CardState; label: string }[] = [
  { state: 'active', label: 'Leave out' },
  { state: 'all', label: 'Include' },
  { state: 'archived', label: 'Only' },
]

/**
 * The filters used less: archived cards, priority, label, due, one of the boards' own fields, leaving parents out,
 * and only the cards you follow.
 */
function MoreMenu({
  search,
  set,
  labels,
  fields,
  field,
}: {
  search: Search
  set: (patch: Partial<Search>) => void
  labels: string[]
  fields: FieldDef[]
  field?: FieldDef
}) {
  // A field picked on other boards than the ones now searched still shows as picked.
  const picked = search.field ? (fields.find((f) => f.id === search.field) ?? field) : undefined
  const choices = picked && !fields.includes(picked) ? [picked, ...fields] : fields
  const n =
    (search.field ? 1 : 0) +
    (search.state !== 'active' ? 1 : 0) +
    (search.priorities?.length ? 1 : 0) +
    (search.label ? 1 : 0) +
    (search.due ? 1 : 0) +
    (search.leaves ? 1 : 0) +
    (search.following ? 1 : 0)
  const toggle = (p: Priority | 'none') => {
    const now = search.priorities ?? []
    const next = now.includes(p) ? now.filter((x) => x !== p) : [...now, p]
    set({ priorities: next.length ? next : undefined })
  }
  // A label picked on other boards than the ones now searched still shows as picked.
  const names = search.label && !labels.some((l) => l.toLowerCase() === search.label!.toLowerCase()) ? [search.label, ...labels] : labels
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 font-normal" aria-label="More filters">
          <FunnelSimple />
          More
          {n > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {n}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      {/* (As tall as the room under the button: the rest scrolls.) */}
      <PopoverContent align="start" className="max-h-(--radix-popover-content-available-height) w-80 overflow-y-auto p-0">
        <Part title="Archived cards">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={search.state}
            onValueChange={(v) => v && set({ state: v as CardState })}
            className="w-full"
            aria-label="Archived cards"
          >
            {ARCHIVED.map((a) => (
              <ToggleGroupItem key={a.state} value={a.state} className="flex-1 text-xs">
                {a.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Part>
        <Part title="Priority">
          {PRIORITIES.map((p) => (
            <CheckRow key={p} checked={!!search.priorities?.includes(p)} onChange={() => toggle(p)}>
              <PriorityIcon priority={p} /> {PRIORITY_LABEL[p]}
            </CheckRow>
          ))}
          <CheckRow checked={!!search.priorities?.includes('none')} onChange={() => toggle('none')}>
            <span className="text-muted-foreground">No priority</span>
          </CheckRow>
        </Part>
        {names.length > 0 && (
          <Part title="Label">
            <Select value={search.label ?? ANY} onValueChange={(v) => set({ label: v === ANY ? undefined : v })}>
              <SelectTrigger size="sm" className="w-full" aria-label="Label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any label</SelectItem>
                {names.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Part>
        )}
        <Part title="Due">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={search.due ?? 'any'}
            onValueChange={(v) => v && set({ due: v === 'any' ? undefined : (v as Search['due']) })}
            className="w-full"
            aria-label="Due"
          >
            <ToggleGroupItem value="any" className="flex-1 text-xs">
              Any
            </ToggleGroupItem>
            <ToggleGroupItem value="overdue" className="flex-1 text-xs">
              Overdue
            </ToggleGroupItem>
            <ToggleGroupItem value="week" className="flex-1 text-xs">
              In 7 days
            </ToggleGroupItem>
            <ToggleGroupItem value="none" className="flex-1 text-xs">
              No date
            </ToggleGroupItem>
          </ToggleGroup>
        </Part>
        {(choices.length > 0 || search.field) && (
          <Part title="Field">
            <Select value={search.field ?? ANY} onValueChange={(v) => set({ field: v === ANY ? undefined : v, fv: undefined })}>
              <SelectTrigger size="sm" className="w-full" aria-label="Field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>No field</SelectItem>
                {choices.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
                {search.field && !picked && <SelectItem value={search.field}>A field of other boards</SelectItem>}
              </SelectContent>
            </Select>
            {picked && (
              <>
                <FieldTest
                  field={picked}
                  value={filterFromText(picked, search.fv ?? '') ?? {}}
                  onChange={(f) => set({ fv: (f && filterToText(picked, f)) || undefined })}
                />
                <p className="pt-1 text-xs text-muted-foreground">
                  {search.fv
                    ? `Only on the boards that use ${picked.name}.`
                    : `Each card says its ${picked.name}. Choose what it has to be to narrow the list.`}
                </p>
              </>
            )}
          </Part>
        )}
        <div className="flex items-center justify-between gap-3 p-4">
          <label htmlFor="cards-leaves" className="cursor-pointer">
            <span className="block text-sm">Hide cards that have subtasks</span>
            <span className="block text-xs text-muted-foreground">Only the cards work is done on, not the ones that group them</span>
          </label>
          <Switch id="cards-leaves" checked={!!search.leaves} onCheckedChange={(on) => set({ leaves: on || undefined })} />
        </div>
        <div className="flex items-center justify-between gap-3 border-t p-4">
          <label htmlFor="cards-following" className="cursor-pointer">
            <span className="block text-sm">Only cards I follow</span>
            <span className="block text-xs text-muted-foreground">
              The ones you’re told about: yours, and those you commented on or chose to follow
            </span>
          </label>
          <Switch id="cards-following" checked={!!search.following} onCheckedChange={(on) => set({ following: on || undefined })} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * What the picked field has to be: any of a choice's options (or none picked), yes or no for a checkbox, for a
 * person field you, someone or no one, and for the other kinds whether it's filled in.
 */
function FieldTest({ field, value, onChange }: { field: FieldDef; value: FieldFilter; onChange: (next: FieldFilter | undefined) => void }) {
  if (field.type === 'choice') {
    const toggle = (id: string) => {
      const next = value.in?.includes(id) ? value.in.filter((x) => x !== id) : [...(value.in ?? []), id]
      onChange(next.length ? { in: next } : undefined)
    }
    return (
      <div className="pt-1">
        {(field.options ?? [])
          .filter((o) => !o.archived || value.in?.includes(o.id))
          .map((o) => (
            <CheckRow key={o.id} checked={!!value.in?.includes(o.id)} onChange={() => toggle(o.id)}>
              <LabelChip label={o} />
            </CheckRow>
          ))}
        <CheckRow checked={!!value.in?.includes('')} onChange={() => toggle('')}>
          <span className="text-muted-foreground">None picked</span>
        </CheckRow>
      </div>
    )
  }
  if (field.type === 'person') {
    // (The boards searched have different people: "me" is the one person who is the same on all of them.)
    const now = value.in?.includes('me') ? 'me' : value.has === undefined ? 'any' : value.has ? 'yes' : 'no'
    return (
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={now}
        onValueChange={(v) => v && onChange(v === 'any' ? undefined : v === 'me' ? { in: ['me'] } : { has: v === 'yes' })}
        className="w-full pt-1"
        aria-label={field.name}
      >
        {[
          ['any', 'Any'],
          ['me', 'Me'],
          ['yes', 'Someone'],
          ['no', 'No one'],
        ].map(([key, text]) => (
          <ToggleGroupItem key={key} value={key} className="flex-1 text-xs">
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    )
  }
  const yesNo = field.type === 'checkbox'
  const now = yesNo ? value.checked : value.has
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={now === undefined ? 'any' : now ? 'yes' : 'no'}
      onValueChange={(v) => v && onChange(v === 'any' ? undefined : yesNo ? { checked: v === 'yes' } : { has: v === 'yes' })}
      className="w-full pt-1"
      aria-label={field.name}
    >
      <ToggleGroupItem value="any" className="flex-1 text-xs">
        Any
      </ToggleGroupItem>
      <ToggleGroupItem value="yes" className="flex-1 text-xs">
        {yesNo ? 'Yes' : 'Filled in'}
      </ToggleGroupItem>
      <ToggleGroupItem value="no" className="flex-1 text-xs">
        {yesNo ? 'No' : 'Empty'}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 border-b p-4 last:border-b-0">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function Pick({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-7 rounded-full border px-2.5 text-xs ${on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-foreground/80 hover:bg-accent'}`}
    >
      {children}
    </button>
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
