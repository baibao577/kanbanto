import { ArrowSquareOut, Check, CheckSquare } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { numberText, optionsOf, parseValue, type BoardField, type FieldValue } from '@kanbanto/model/fields'
import { LabelChip } from '@/components/common/bits'
import { DateField, FieldButton } from '@/components/task/pickers'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import { LinkFront, LinkValueEditor, LinkValueText } from './LinkValue'
import { PersonFront, PersonValueEditor, PersonValueText } from './PersonValue'
import { linkOf } from './values'

const CHIP = 'inline-flex h-5 max-w-full items-center gap-1 rounded px-1.5 text-[11px] font-medium'

/** A card's value for one of the board's fields, as a small chip on the card front. */
export function FieldChip({ field, value }: { field: BoardField; value: FieldValue }) {
  if (field.type === 'link') return <LinkFront field={field} value={value} />
  if (field.type === 'person') return <PersonFront field={field} value={value} />
  if (field.type === 'choice') {
    const [option] = optionsOf(field, value)
    return option ? <LabelChip label={option} className={cn('min-w-0', option.archived && 'opacity-60')} /> : null
  }
  if (field.type === 'checkbox')
    return (
      <span className={cn(CHIP, 'bg-muted text-muted-foreground')} title={field.name}>
        <CheckSquare weight="fill" className="size-3 text-status-done" />
        <span className="truncate">{field.name}</span>
      </span>
    )
  if (Array.isArray(value)) return null
  const text = field.type === 'number' ? numberText(field, value as number) : field.type === 'date' ? formatDay(String(value)) : String(value)
  return (
    <span className={cn(CHIP, 'bg-muted text-muted-foreground')} title={`${field.name}: ${text}`}>
      <span className="shrink-0 opacity-70">{field.name}</span>
      <span className="truncate text-foreground/85 tabular-nums">{text}</span>
    </span>
  )
}

/**
 * A card's value for one of the board's fields, edited in place: in the card's side column, or (`cell`) in a cell of
 * the Outline, where an empty value is simply blank. `onChange(null)` clears it. `placeholder`: what an empty text or
 * number box says instead (a parent's total, in the Outline). Inside a disabled fieldset (a viewer's card) everything
 * here is read-only without being told.
 */
export function FieldValueEditor({
  field,
  value,
  onChange,
  cell,
  placeholder,
  taskId,
}: {
  field: BoardField
  value: FieldValue | undefined
  onChange: (v: FieldValue | null) => void
  cell?: boolean
  placeholder?: string
  /** The card being edited (a card link doesn't offer the card itself). */
  taskId?: string
}) {
  if (field.type === 'link') return <LinkValueEditor field={field} value={value} onChange={onChange} cell={cell} taskId={taskId} />
  if (field.type === 'person') return <PersonValueEditor field={field} value={value} onChange={onChange} cell={cell} />
  if (field.type === 'date')
    return (
      <DateField
        value={typeof value === 'string' ? value : undefined}
        placeholder={cell ? '' : 'Add a date'}
        bare={cell}
        onChange={(v) => onChange(v ?? null)}
      />
    )
  if (field.type === 'checkbox')
    return cell ? (
      // (A plain button that looks like the app's checkbox: a table has thousands of these, and that one is heavy.)
      <button
        type="button"
        role="checkbox"
        aria-checked={!!value}
        aria-label={field.name}
        onClick={() => onChange(value ? null : true)}
        className={cn(
          'mx-2 grid size-4 shrink-0 place-content-center rounded-[4px] border border-input shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30',
          !!value && 'border-primary bg-primary text-primary-foreground dark:bg-primary',
        )}
      >
        {!!value && <Check className="size-3.5" />}
      </button>
    ) : (
      <label className="flex h-8 items-center justify-between gap-2 px-2 text-sm">
        <span className={cn(!value && 'text-muted-foreground')}>{value ? 'Yes' : 'No'}</span>
        <Switch checked={!!value} onCheckedChange={(on) => onChange(on || null)} aria-label={field.name} />
      </label>
    )
  if (field.type === 'choice') return <ChoiceValue field={field} value={value} onChange={onChange} cell={cell} />
  return (
    <TypedValue
      field={field}
      value={typeof value === 'string' || typeof value === 'number' ? value : undefined}
      onChange={onChange}
      placeholder={placeholder ?? (cell ? '' : undefined)}
    />
  )
}

/** A card's value for a field, just shown (a viewer's Outline): nothing when there's none. */
export function FieldValueText({ field, value }: { field: BoardField; value: FieldValue | undefined }) {
  if (value === undefined) return null
  if (field.type === 'link') return <LinkValueText value={value} cell />
  if (field.type === 'person') return <PersonValueText value={value} cell />
  if (field.type === 'choice') {
    const [option] = optionsOf(field, value)
    return option ? <LabelChip label={option} className={cn('min-w-0', option.archived && 'opacity-60')} /> : null
  }
  if (field.type === 'checkbox') return <CheckSquare weight="fill" className="mx-2 size-4 text-status-done" aria-label="Yes" />
  if (Array.isArray(value)) return null
  const text = field.type === 'number' ? numberText(field, value as number) : field.type === 'date' ? formatDay(String(value)) : String(value)
  const href = field.type === 'text' ? linkOf(field, text) : null
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className="truncate px-2 text-sm text-primary hover:underline">
      {text}
    </a>
  ) : (
    <span className={cn('truncate px-2 text-sm', field.type === 'number' && 'tabular-nums')}>{text}</span>
  )
}

/** Text or a number: typed in place, saved on leaving the box or Enter. A number shows with its unit until you edit it. */
function TypedValue({
  field,
  value,
  onChange,
  placeholder,
}: {
  field: BoardField
  value: string | number | undefined
  onChange: (v: FieldValue | null) => void
  /** Instead of "Add text…": '' in a table cell, or a parent's total. */
  placeholder?: string
}) {
  const number = field.type === 'number'
  const raw = value === undefined ? '' : String(value)
  const shown = value === undefined ? '' : number ? numberText(field, value as number) : raw
  const ref = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  // Someone else's change shows here too, unless you're typing.
  useEffect(() => {
    if (ref.current && !editing) ref.current.value = shown
  }, [shown, editing])
  const commit = () => {
    const el = ref.current!
    setEditing(false)
    if (el.value.trim() === raw) {
      el.value = shown
      return
    }
    const r = parseValue(field, el.value)
    if ('error' in r) {
      toast.error(`${field.name}: ${r.error}`)
      el.value = shown
      return
    }
    onChange(r.value ?? null)
  }
  const href = !number && value !== undefined ? linkOf(field, raw) : null
  return (
    <div className="flex items-center gap-1">
      <input
        ref={ref}
        defaultValue={shown}
        aria-label={field.name}
        inputMode={
          number ? 'decimal' : field.format === 'email' ? 'email' : field.format === 'phone' ? 'tel' : field.format === 'link' ? 'url' : undefined
        }
        placeholder={
          placeholder ??
          (number
            ? 'Add a number'
            : field.format === 'link'
              ? 'Add a link'
              : field.format === 'email'
                ? 'Add an email'
                : field.format === 'phone'
                  ? 'Add a number'
                  : 'Add text')
        }
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.value = raw
          e.currentTarget.select()
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={cn(
          'h-8 w-full min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none transition-colors placeholder:text-muted-foreground',
          'hover:bg-accent focus:bg-background focus:ring-2 focus:ring-ring/40 disabled:hover:bg-transparent',
          number && 'tabular-nums',
          href && !editing && 'text-primary',
        )}
      />
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title={field.format === 'email' ? 'Write an email' : field.format === 'phone' ? 'Call' : 'Open the link'}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowSquareOut className="size-4" />
        </a>
      )}
    </div>
  )
}

/** One of a choice field's options. An option that's been archived shows on the card that has it, and can't be picked. */
function ChoiceValue({
  field,
  value,
  onChange,
  cell,
}: {
  field: BoardField
  value: FieldValue | undefined
  onChange: (v: FieldValue | null) => void
  cell?: boolean
}) {
  const [open, setOpen] = useState(false)
  // In a table cell, the menu is only built once it's first opened: a table has thousands of these.
  const [built, setBuilt] = useState(!cell)
  const [current] = optionsOf(field, value)
  const options = (field.options ?? []).filter((o) => !o.archived)
  const choose = (id: string | null) => {
    setOpen(false)
    if ((current?.id ?? null) !== id) onChange(id ? [id] : null)
  }
  const label = `${field.name}: ${current?.name ?? 'none'}`
  const shown = current ? <LabelChip label={current} className={cn('min-w-0', current.archived && 'opacity-60')} /> : cell ? '' : 'None'
  if (!built)
    return (
      <FieldButton
        empty={!current}
        type="button"
        aria-haspopup="dialog"
        aria-label={label}
        onClick={() => {
          setBuilt(true)
          setOpen(true)
        }}
      >
        {shown}
      </FieldButton>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FieldButton empty={!current} type="button" aria-label={label}>
          {shown}
        </FieldButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1">
        <ul className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => choose(o.id)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
              >
                <LabelChip label={o} className="min-w-0" />
                {current?.id === o.id && <Check weight="bold" className="ml-auto size-3.5 shrink-0" />}
              </button>
            </li>
          ))}
          {!options.length && <li className="px-2 py-1.5 text-xs text-muted-foreground">This field has no options yet.</li>}
        </ul>
        {current && (
          <button
            type="button"
            onClick={() => choose(null)}
            className="mt-1 flex h-8 w-full items-center rounded-md border-t px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
