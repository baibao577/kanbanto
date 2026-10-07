import { MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar, LabelChip } from '@/components/common/bits'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { MAX_DATE_DAYS, type DateTest, type DateWord } from '@kanbanto/model/dates'
import { dateTestOf, FILTER_TEXT_MAX, ME, withDateTest, type FieldDef, type FieldFilter, type TextMatch } from '@kanbanto/model/fields'

/**
 * What a field has to be to pass a filter, for each kind of field: a test to pick ("contains", "is at least",
 * "this month", "is none of") and what it's held against. The Filter menu of a board and the Search cards page both
 * use it, so a filter is made the same way in both; the rules themselves are in model/fields.ts.
 */

export function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2.5 text-sm">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
    </label>
  )
}

/**
 * A function called a moment after the last of a run of calls: typing changes the filter once the typing pauses,
 * not at every letter. What's still waiting when the control goes away (the menu closes) is sent then.
 */
function useLater<A extends unknown[]>(fn: (...args: A) => void, ms = 250) {
  const latest = useRef(fn)
  useEffect(() => {
    latest.current = fn
  })
  const waiting = useRef<{ timer: ReturnType<typeof setTimeout>; args: A } | null>(null)
  useEffect(
    () => () => {
      if (!waiting.current) return
      clearTimeout(waiting.current.timer)
      latest.current(...waiting.current.args)
    },
    [],
  )
  return (...args: A) => {
    if (waiting.current) clearTimeout(waiting.current.timer)
    const timer = setTimeout(() => {
      waiting.current = null
      latest.current(...args)
    }, ms)
    waiting.current = { timer, args }
  }
}

/** The test picked, kept while it isn't a whole filter yet ("contains" with nothing typed): then the filter is unset. */
/**
 * `fits`: whether the filter as it is can be read as the test picked, where it can be read as more than one
 * ("between" with one number typed is also "at least"): then the one picked is the one shown.
 */
function usePicked<K extends string>(fromValue: K | undefined, first: K, fits?: (k: K) => boolean) {
  const [picked, setPicked] = useState<K>(fromValue ?? first)
  const mine = useRef(false)
  const had = useRef(fromValue !== undefined)
  // Cleared from elsewhere ("Clear filters", a saved filter picked): back to the first test.
  useEffect(() => {
    if (had.current && fromValue === undefined && !mine.current) setPicked(first)
    had.current = fromValue !== undefined
    mine.current = false
  }, [fromValue, first])
  return [
    fits?.(picked) ? picked : (fromValue ?? picked),
    (k: K) => {
      mine.current = true
      setPicked(k)
    },
  ] as const
}

const selectClass = 'h-7 w-full text-sm'

// ── A test of a day ─────────────────────────────────────

type DayKey = DateWord | 'before' | 'after' | 'between' | 'overdue' | 'all'
const DAY_LABEL: Record<Exclude<DayKey, 'all' | 'overdue'>, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  yesterday: 'Yesterday',
  'this-week': 'This week',
  'next-week': 'Next week',
  'last-week': 'Last week',
  'this-month': 'This month',
  'next-month': 'Next month',
  'last-month': 'Last month',
  next: 'In the next…',
  last: 'In the last…',
  before: 'On or before…',
  after: 'On or after…',
  between: 'Between…',
  past: 'In the past',
  future: 'In the future',
  any: 'Has a date',
  none: 'No date',
}
const DAY_GROUPS: Exclude<DayKey, 'all' | 'overdue'>[][] = [
  ['today', 'tomorrow', 'yesterday'],
  ['this-week', 'next-week', 'last-week'],
  ['this-month', 'next-month', 'last-month'],
  ['next', 'last'],
  ['before', 'after', 'between'],
  ['past', 'future'],
  ['any', 'none'],
]
const dayKeyOf = (v: 'overdue' | DateTest | undefined): DayKey | undefined =>
  v === undefined ? undefined : v === 'overdue' ? 'overdue' : (v.on ?? (v.from && v.to ? 'between' : v.from ? 'after' : 'before'))

/**
 * Picks a test of a day: a word (today, this month…), the next or last so many days, or days given outright.
 * `any`: what leaving it unset is called ("Any date"); without it there's nothing to leave unset (a field's own
 * filter is taken away with its ✕). `overdue`: offered for a due date.
 */
export function DateTestSelect({
  label,
  value,
  onChange,
  any,
  overdue,
}: {
  label: string
  value: 'overdue' | DateTest | undefined
  onChange: (next: 'overdue' | DateTest | undefined) => void
  any?: string
  overdue?: boolean
}) {
  const [key, setKey] = usePicked<DayKey>(dayKeyOf(value), 'all')
  // What's been typed for the tests that need it, kept as the test changes: the days, and the two days.
  const [draft, setDraft] = useState<DateTest>(typeof value === 'object' ? value : {})
  const given = typeof value === 'object' ? value : undefined
  const d: DateTest = { days: given?.days ?? draft.days, from: given?.from ?? draft.from, to: given?.to ?? draft.to }
  const say = (k: DayKey, with_: DateTest = d) => {
    setKey(k)
    setDraft(with_)
    const days = with_.days ?? 7
    onChange(
      k === 'all'
        ? undefined
        : k === 'overdue'
          ? 'overdue'
          : k === 'next' || k === 'last'
            ? { on: k, days }
            : k === 'before'
              ? with_.to
                ? { to: with_.to }
                : undefined
              : k === 'after'
                ? with_.from
                  ? { from: with_.from }
                  : undefined
                : k === 'between'
                  ? with_.from && with_.to
                    ? { from: with_.from, to: with_.to }
                    : undefined
                  : { on: k },
    )
  }
  const later = useLater(say)
  const day = (part: 'from' | 'to', name: string) => (
    <Input
      type="date"
      aria-label={`${label}, ${name}`}
      value={d[part] ?? ''}
      onChange={(e) => say(key, { ...d, [part]: e.target.value || undefined })}
      className="h-7 min-w-0 flex-1 px-2 text-sm"
    />
  )
  return (
    <div className="space-y-1.5">
      <Select value={key === 'all' && !any ? '' : key} onValueChange={(k) => say(k as DayKey)}>
        <SelectTrigger size="sm" className={selectClass} aria-label={label}>
          <SelectValue placeholder="Choose when…" />
        </SelectTrigger>
        <SelectContent>
          {(any || overdue) && (
            <>
              <SelectGroup>
                {any && <SelectItem value="all">{any}</SelectItem>}
                {overdue && <SelectItem value="overdue">Overdue</SelectItem>}
              </SelectGroup>
              <SelectSeparator />
            </>
          )}
          {DAY_GROUPS.map((group, i) => (
            <div key={group[0]}>
              {i > 0 && <SelectSeparator />}
              <SelectGroup>
                {group.map((k) => (
                  <SelectItem key={k} value={k}>
                    {DAY_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </div>
          ))}
        </SelectContent>
      </Select>
      {(key === 'next' || key === 'last') && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_DATE_DAYS}
            aria-label={`${label}, days`}
            defaultValue={d.days ?? 7}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              if (n >= 1 && n <= MAX_DATE_DAYS) later(key, { ...d, days: n })
            }}
            className="h-7 w-20 px-2 text-sm"
          />
          days, today included
        </label>
      )}
      {key === 'before' && day('to', 'the last day')}
      {key === 'after' && day('from', 'the first day')}
      {key === 'between' && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {day('from', 'the first day')} and {day('to', 'the last day')}
        </div>
      )}
    </div>
  )
}

// ── Each kind of field ──────────────────────────────────

type Props = {
  field: FieldDef
  value: FieldFilter
  onChange: (next: FieldFilter | undefined) => void
  /** The people a person field can be asked for: the board's, or everyone on the boards searched. */
  people?: { id: string; name: string; picture?: string | null }[]
  /**
   * The cards a card link can be asked for (the ones the board's cards link to), how to name one and how to draw
   * one. Without it (several boards at once), only whether there is a link.
   */
  links?: { refs: string[]; titleOf: (ref: string) => string | undefined; chip: (ref: string) => ReactNode }
}

type TextKey = 'contains' | TextMatch | 'filled' | 'empty'
const TEXT_LABEL: [TextKey, string][] = [
  ['contains', 'Contains'],
  ['not', 'Doesn’t contain'],
  ['is', 'Is exactly'],
  ['is-not', 'Isn’t'],
  ['filled', 'Is filled in'],
  ['empty', 'Is empty'],
]

function TextCriteria({ field, value, onChange }: Props) {
  const [key, setKey] = usePicked<TextKey>(
    value.has !== undefined ? (value.has ? 'filled' : 'empty') : value.text !== undefined ? (value.match ?? 'contains') : undefined,
    'contains',
  )
  const [text, setText] = useState(value.text ?? '')
  const say = (k: TextKey, t: string) => {
    setKey(k)
    onChange(k === 'filled' || k === 'empty' ? { has: k === 'filled' } : t.trim() ? { text: t, ...(k !== 'contains' && { match: k }) } : undefined)
  }
  const later = useLater(say)
  return (
    <div className="space-y-1.5">
      <Select value={key} onValueChange={(k) => say(k as TextKey, text)}>
        <SelectTrigger size="sm" className={selectClass} aria-label={`${field.name}: the test`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TEXT_LABEL.map(([k, name]) => (
            <SelectItem key={k} value={k}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {key !== 'filled' && key !== 'empty' && (
        <Input
          aria-label={`${field.name}: the text`}
          placeholder="Text to look for"
          maxLength={FILTER_TEXT_MAX}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            later(key, e.target.value)
          }}
          className="h-7 px-2 text-sm"
        />
      )}
    </div>
  )
}

type NumberKey = 'is' | 'min' | 'max' | 'between' | 'filled' | 'empty'
const NUMBER_LABEL: [NumberKey, string][] = [
  ['is', 'Is'],
  ['min', 'Is at least'],
  ['max', 'Is at most'],
  ['between', 'Is between'],
  ['filled', 'Has a number'],
  ['empty', 'Is empty'],
]

function NumberCriteria({ field, value, onChange }: Props) {
  const [key, setKey] = usePicked<NumberKey>(
    value.has !== undefined
      ? value.has
        ? 'filled'
        : 'empty'
      : value.min !== undefined && value.max !== undefined
        ? value.min === value.max
          ? 'is'
          : 'between'
        : value.min !== undefined
          ? 'min'
          : value.max !== undefined
            ? 'max'
            : undefined,
    'min',
    // ("Between" with one of its two numbers given.)
    (k) => k === 'between' && value.has === undefined && (value.min !== undefined || value.max !== undefined),
  )
  // The two numbers typed: the first is "at least" (and the only one for "is"), the second "at most".
  const [typed, setTyped] = useState<[number | undefined, number | undefined]>([value.min ?? value.max, value.max])
  const say = (k: NumberKey, [a, b]: [number | undefined, number | undefined]) => {
    setKey(k)
    setTyped([a, b])
    const one = a ?? b
    onChange(
      k === 'filled' || k === 'empty'
        ? { has: k === 'filled' }
        : k === 'is'
          ? one !== undefined
            ? { min: one, max: one }
            : undefined
          : k === 'min'
            ? one !== undefined
              ? { min: one }
              : undefined
            : k === 'max'
              ? one !== undefined
                ? { max: one }
                : undefined
              : a !== undefined || b !== undefined
                ? { ...(a !== undefined && { min: a }), ...(b !== undefined && { max: b }) }
                : undefined,
    )
  }
  const later = useLater(say)
  const box = (at: 0 | 1, name: string) => (
    <Input
      key={`${key}-${at}`}
      type="number"
      inputMode="decimal"
      step="any"
      aria-label={`${field.name}, ${name}`}
      defaultValue={typed[at] ?? ''}
      onChange={(e) => {
        const n = e.target.value.trim() === '' ? undefined : Number(e.target.value)
        if (n === undefined || Number.isFinite(n)) later(key, at === 0 ? [n, typed[1]] : [typed[0], n])
      }}
      className="h-7 min-w-0 flex-1 px-2 text-sm"
    />
  )
  return (
    <div className="space-y-1.5">
      <Select value={key} onValueChange={(k) => say(k as NumberKey, typed)}>
        <SelectTrigger size="sm" className={selectClass} aria-label={`${field.name}: the test`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NUMBER_LABEL.map(([k, name]) => (
            <SelectItem key={k} value={k}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {key === 'between' ? (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {box(0, 'at least')} and {box(1, 'at most')}
        </div>
      ) : (
        key !== 'filled' &&
        key !== 'empty' && <div className="flex">{box(0, key === 'is' ? 'the number' : key === 'min' ? 'at least' : 'at most')}</div>
      )}
    </div>
  )
}

type ListKey = 'any' | 'none' | 'has'

/** A choice, a card link or a person field: any of some, none of some, or (a link, a person) just that there is one. */
function ListCriteria({
  field,
  value,
  onChange,
  rows,
  noneLabel,
  hasLabel,
  find,
}: Props & {
  /** What can be ticked: its id, what to draw, and its name for finding it by typing. */
  rows: { id: string; row: ReactNode; name?: string }[]
  noneLabel: string
  /** "Has a link", "Has someone": offered when the kind has such a test. */
  hasLabel?: string
  /** A box to find a row by typing, for lists that can be long. */
  find?: boolean
}) {
  const [key, setKey] = usePicked<ListKey>(value.has === true ? 'has' : value.notIn ? 'none' : value.in ? 'any' : undefined, 'any')
  const [typed, setTyped] = useState('')
  const ticked = (key === 'none' ? value.notIn : value.in) ?? []
  const say = (k: ListKey, list: string[]) => {
    setKey(k)
    onChange(k === 'has' ? { has: true } : list.length ? (k === 'none' ? { notIn: list } : { in: list }) : undefined)
  }
  const toggle = (id: string) => say(key, ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id])
  const q = typed.trim().toLowerCase()
  // What's ticked stays in the list, whatever is typed, so it can always be seen and unticked.
  const matching = q ? rows.filter((r) => ticked.includes(r.id) || r.name?.toLowerCase().includes(q)) : rows
  const shown = matching.slice(0, MAX_ROWS)
  return (
    <div className="space-y-1">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={key}
        onValueChange={(k) => k && say(k as ListKey, ticked)}
        aria-label={`${field.name}: the test`}
        className="w-full"
      >
        <ToggleGroupItem value="any" className="flex-1 text-xs">
          Is any of
        </ToggleGroupItem>
        <ToggleGroupItem value="none" className="flex-1 text-xs">
          Is none of
        </ToggleGroupItem>
        {hasLabel && (
          <ToggleGroupItem value="has" className="flex-1 text-xs">
            {hasLabel}
          </ToggleGroupItem>
        )}
      </ToggleGroup>
      {key !== 'has' && (
        <>
          {find && rows.length > FIND_FROM && (
            <div className="relative pt-0.5">
              <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-[40%] text-muted-foreground" />
              <Input
                aria-label={`${field.name}: find a card`}
                placeholder="Find by title"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="h-7 pr-2 pl-7 text-sm"
              />
            </div>
          )}
          {shown.map((r) => (
            <CheckRow key={r.id} checked={ticked.includes(r.id)} onChange={() => toggle(r.id)}>
              {r.row}
            </CheckRow>
          ))}
          {matching.length > shown.length && (
            <p className="py-1 text-xs text-muted-foreground">
              {matching.length - shown.length} more: type {q ? 'more of' : 'part of'} a title to find one.
            </p>
          )}
          {q && !matching.length && <p className="py-1 text-xs text-muted-foreground">No card with that in its title is linked here.</p>}
          <CheckRow checked={ticked.includes('')} onChange={() => toggle('')}>
            <span className="text-muted-foreground">{noneLabel}</span>
          </CheckRow>
        </>
      )}
    </div>
  )
}
/** Rows shown at once in a list to tick from, and how long a list has to be before it gets a box to find one in. */
const MAX_ROWS = 50
const FIND_FROM = 8

/** Any, or one of a few: the whole of a filter for a kind that needs no more. */
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

export function FieldCriteria(p: Props) {
  const { field, value, onChange } = p
  switch (field.type) {
    case 'text':
      return <TextCriteria {...p} />
    case 'number':
      return <NumberCriteria {...p} />
    case 'date':
      return (
        <DateTestSelect
          label={field.name}
          value={dateTestOf(value)}
          onChange={(next) => onChange(withDateTest(typeof next === 'object' ? next : undefined))}
        />
      )
    case 'checkbox':
      return (
        <OneOf
          label={field.name}
          value={value.checked === undefined ? 'any' : value.checked ? 'yes' : 'no'}
          options={[
            ['yes', 'Yes'],
            ['no', 'No'],
          ]}
          onChange={(v) => onChange(v === 'any' ? undefined : { checked: v === 'yes' })}
        />
      )
    case 'choice': {
      const ticked = [...(value.in ?? []), ...(value.notIn ?? [])]
      return (
        <ListCriteria
          {...p}
          noneLabel="None picked"
          rows={(field.options ?? [])
            .filter((o) => !o.archived || ticked.includes(o.id))
            .map((o) => ({ id: o.id, name: o.name, row: <LabelChip label={o} /> }))}
        />
      )
    }
    case 'person':
      return (
        <ListCriteria
          {...p}
          noneLabel="No one"
          hasLabel="Has someone"
          rows={[
            { id: ME, row: <span>Me</span> },
            ...(p.people ?? []).map((m) => ({
              id: m.id,
              name: m.name,
              row: (
                <>
                  <Avatar name={m.name} picture={m.picture} className="size-5 text-[9px]" /> {m.name}
                </>
              ),
            })),
          ]}
        />
      )
    case 'link':
      if (!p.links)
        return (
          <OneOf
            label={field.name}
            value={value.has === undefined ? 'any' : value.has ? 'yes' : 'no'}
            options={[
              ['yes', 'Has a link'],
              ['no', 'None linked'],
            ]}
            onChange={(v) => onChange(v === 'any' ? undefined : { has: v === 'yes' })}
          />
        )
      return (
        <ListCriteria
          {...p}
          find
          noneLabel="None linked"
          hasLabel="Has a link"
          rows={p.links.refs.map((ref) => ({ id: ref, name: p.links!.titleOf(ref), row: p.links!.chip(ref) }))}
        />
      )
    default:
      return null
  }
}
