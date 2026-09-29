import { CalendarBlank, CellSignalHigh, CellSignalLow, CellSignalMedium, Check, Prohibit, WarningCircle } from '@phosphor-icons/react'
import { formatDay, initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BOARD_BACKGROUNDS, COLORS, statusTone, tone, type ColorName } from '@kanbanto/model/colors'
import { isPast } from '@kanbanto/model/dates'
import { PRIORITY_LABEL, type Category, type LabelDef, type Priority, type StatusColumn } from '@kanbanto/model/types'

/** A status dot. Backlog is a hollow ring: planned, not ready yet. */
export function StatusDot({ category, color, className }: { category: Category; color?: ColorName; className?: string }) {
  const c = statusTone(category, color)
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={category === 'backlog' ? { boxShadow: `inset 0 0 0 1.5px ${c}` } : { backgroundColor: c }}
    />
  )
}

/** A status name, tinted by its list's color (or what it counts as). */
export function StatusPill({ col, className }: { col: StatusColumn; className?: string }) {
  const c = statusTone(col.category, col.color)
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap text-foreground/80', className)}
      style={{ backgroundColor: `color-mix(in oklab, ${c} 18%, transparent)` }}
    >
      <StatusDot category={col.category} color={col.color} className="size-1.5" />
      {col.name}
    </span>
  )
}

/** A Trello-style label: a colored pill with its name (or just color when it has none). */
export function LabelChip({ label, className }: { label: Pick<LabelDef, 'name' | 'color'>; className?: string }) {
  return (
    <span
      title={label.name || undefined}
      className={cn('inline-flex h-5 min-w-10 items-center rounded px-1.5 text-[11px] font-semibold text-foreground/85', className)}
      style={{ backgroundColor: `color-mix(in oklab, ${tone(label.color)} 32%, transparent)` }}
    >
      <span className="truncate">{label.name}</span>
    </span>
  )
}

/** Pick a board background: 12 gradient tiles plus the plain default. */
export function BackgroundSwatches({ value, onChange }: { value?: ColorName; onChange: (c: ColorName | undefined) => void }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-1.5">
        {COLORS.map((c) => {
          const g = BOARD_BACKGROUNDS[c.id]
          return (
            <button
              key={c.id}
              type="button"
              title={c.name}
              aria-label={`${c.name} background`}
              aria-pressed={value === c.id}
              onClick={() => onChange(c.id)}
              className="grid h-10 place-items-center rounded-md outline-none ring-offset-2 ring-offset-popover transition-transform hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-ring"
              style={{ background: `linear-gradient(135deg, ${g.from}, ${g.to})` }}
            >
              {value === c.id && <Check weight="bold" className={cn('size-4 drop-shadow', g.text === 'light' ? 'text-white' : 'text-black/70')} />}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        onClick={() => onChange(undefined)}
        className={cn(
          'flex h-8 w-full items-center justify-center gap-1.5 rounded-md border bg-background text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
          !value && 'border-ring text-foreground',
        )}
      >
        Default (no color)
      </button>
    </div>
  )
}

/** Pick one of the 12 palette colors; "none" is optional. */
export function ColorSwatches({
  value,
  onChange,
  noneLabel,
}: {
  value?: ColorName
  onChange: (c: ColorName | undefined) => void
  noneLabel?: string
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-6 gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.name}
            aria-label={c.name}
            aria-pressed={value === c.id}
            onClick={() => onChange(c.id)}
            className="grid h-7 place-items-center rounded-md outline-none ring-offset-2 ring-offset-popover transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
            style={{ backgroundColor: tone(c.id) }}
          >
            {value === c.id && <Check weight="bold" className="size-3.5 text-white drop-shadow" />}
          </button>
        ))}
      </div>
      {noneLabel && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className={cn(
            'flex h-7 w-full items-center justify-center gap-1.5 rounded-md border text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
            !value && 'border-ring text-foreground',
          )}
        >
          <Prohibit className="size-3.5" /> {noneLabel}
        </button>
      )}
    </div>
  )
}

export function ProgressBar({
  done,
  total,
  className,
  onCanvas,
}: {
  done: number
  total: number
  className?: string
  /** Drawn straight on the board background (uses its text colors). */
  onCanvas?: boolean
}) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className={cn('flex items-center gap-2', className)} title={`${done} of ${total} subtasks done`}>
      <div className={cn('h-1.5 min-w-10 flex-1 overflow-hidden rounded-full', onCanvas ? 'bg-(--canvas-chip)' : 'bg-foreground/8')}>
        <div className="h-full rounded-full bg-status-done transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('text-[11px] tabular-nums', onCanvas ? 'text-(--canvas-muted)' : 'text-muted-foreground')}>
        {done}/{total}
      </span>
    </div>
  )
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      title={name}
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-secondary-foreground ring-1 ring-border',
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

/** Due date on a card; red when it's past and the task isn't done. */
export function DueChip({ due, done }: { due: string; done: boolean }) {
  const overdue = !done && isPast(due)
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium',
        overdue ? 'bg-destructive/12 text-destructive' : 'text-muted-foreground',
        done && 'text-status-done',
      )}
      title={overdue ? 'Overdue' : 'Due date'}
    >
      <CalendarBlank weight="bold" className="size-3" />
      {formatDay(due)}
    </span>
  )
}

const PRIORITY_ICON = { urgent: WarningCircle, high: CellSignalHigh, medium: CellSignalMedium, low: CellSignalLow }

/** A task's priority: a filled alert for urgent, signal bars for the rest (like Linear). */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const Icon = PRIORITY_ICON[priority]
  return (
    <Icon
      weight={priority === 'urgent' ? 'fill' : 'bold'}
      aria-label={`${PRIORITY_LABEL[priority]} priority`}
      className={cn(
        'size-3.5 shrink-0',
        priority === 'urgent' ? 'text-destructive' : priority === 'high' ? 'text-foreground' : 'text-muted-foreground',
        className,
      )}
    />
  )
}

/** On a card: urgent says so; the others are just their icon. */
export function PriorityChip({ priority }: { priority: Priority }) {
  if (priority === 'urgent')
    return (
      <span className="inline-flex h-5 items-center gap-1 rounded bg-destructive/12 px-1.5 text-[11px] font-medium text-destructive">
        <PriorityIcon priority="urgent" className="size-3" /> Urgent
      </span>
    )
  return (
    <span className="inline-flex h-5 items-center" title={`${PRIORITY_LABEL[priority]} priority`}>
      <PriorityIcon priority={priority} />
    </span>
  )
}

/** A small swatch of a board's background (or the plain canvas). */
export function BoardDot({ background }: { background?: ColorName }) {
  const bg = background ? BOARD_BACKGROUNDS[background] : null
  return (
    <span
      className="size-4 shrink-0 rounded border"
      style={bg ? { background: `linear-gradient(135deg, ${bg.from}, ${bg.to})`, borderColor: 'transparent' } : undefined}
    />
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
