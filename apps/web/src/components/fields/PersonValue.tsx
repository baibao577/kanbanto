import { Check, PencilSimple, Plus, X } from '@phosphor-icons/react'
import { useState } from 'react'
import { peopleOf, type BoardField, type FieldValue } from '@kanbanto/model/fields'
import { useBoard } from '@/app/board-context'
import { useLinks, usePerson } from '@/app/links-context'
import { Avatar } from '@/components/common/bits'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** Someone a card still names who isn't one of the board's people any more. */
const GONE = 'Someone who left'

const CHIP = 'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-card pr-2 pl-0.5 text-xs'

/** One of the board's people, as a chip: their initials and name. `onRemove`: an ✕ that takes them out. */
export function PersonChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const name = usePerson(id)
  return (
    <span className={cn(CHIP, !name && 'border-dashed pl-2 text-muted-foreground italic', onRemove && 'pr-0.5')}>
      {name && <Avatar name={name} className="size-5 text-[9px]" />}
      <span className="truncate">{name ?? GONE}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={name ? `Remove ${name}` : 'Remove them'}
          className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:hidden"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/** Just the initials (a "?" for someone who left). */
function Face({ id, className }: { id: string; className?: string }) {
  const name = usePerson(id)
  return name ? (
    <Avatar name={name} className={className} />
  ) : (
    <span
      title={GONE}
      className={cn('inline-grid size-6 shrink-0 place-items-center rounded-full border border-dashed text-[10px] text-muted-foreground', className)}
    >
      ?
    </span>
  )
}

/** The initials of the first few people, overlapping, and how many more there are. */
function Faces({ ids, max = 3, className }: { ids: string[]; max?: number; className?: string }) {
  return (
    <span className="flex shrink-0 items-center -space-x-1">
      {ids.slice(0, max).map((id) => (
        <Face key={id} id={id} className={className} />
      ))}
      {ids.length > max && <span className="pl-1.5 text-[11px] text-muted-foreground tabular-nums">+{ids.length - max}</span>}
    </span>
  )
}

/** A person field on a card front: the field's name and the people's initials. Not a button: the card is. */
export function PersonFront({ field, value }: { field: BoardField; value: FieldValue }) {
  const ids = peopleOf(value)
  if (!ids.length) return null
  return (
    <span className="inline-flex h-5 max-w-full items-center gap-1 rounded bg-muted pr-1 pl-1.5 text-[11px] font-medium text-muted-foreground">
      <span className="truncate opacity-70">{field.name}</span>
      <Faces ids={ids} className="size-4 text-[8px]" />
    </span>
  )
}

/** A person field's people, just shown (a viewer's card or Outline). */
export function PersonValueText({ value, cell }: { value: FieldValue | undefined; cell?: boolean }) {
  const ids = peopleOf(value)
  if (!ids.length) return null
  if (cell && ids.length > 1) return <span className="px-2">{<Faces ids={ids} max={5} className="size-5 text-[9px]" />}</span>
  return (
    <span className={cn('flex min-w-0 gap-1 px-1', cell ? 'overflow-hidden' : 'flex-wrap py-1')}>
      {ids.map((id) => (
        <PersonChip key={id} id={id} />
      ))}
    </span>
  )
}

/**
 * A person field's people, edited in place: chips, and a picker of the board's people. One person, or several when
 * the field holds several. In an Outline cell (`cell`) they stay on one line (initials only, for several) and the
 * picker's button shows when you point at the cell. Someone who has left the board goes with the next change.
 */
export function PersonValueEditor({
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
  const links = useLinks()
  const ids = peopleOf(value)
  const [open, setOpen] = useState(false)
  const here = () => ids.filter((id) => links?.store.nameOf(id) !== undefined)
  const set = (next: string[]) => onChange(next.length ? next : null)
  const remove = (id: string) => set(here().filter((x) => x !== id))
  const toggle = (id: string) => {
    if (ids.includes(id)) return remove(id)
    set(field.many ? [...here(), id] : [id])
    if (!field.many) setOpen(false)
  }
  const empty = !ids.length
  const label = empty ? `Add someone to ${field.name}` : field.many ? `Add someone else to ${field.name}` : `Change ${field.name}`
  return (
    <div className={cn('group/person flex min-w-0 items-center gap-1 px-1', cell ? 'h-8' : 'min-h-8 flex-wrap py-1')}>
      {cell && ids.length > 1 ? (
        <span className="px-1">
          <Faces ids={ids} max={5} className="size-5 text-[9px]" />
        </span>
      ) : (
        ids.map((id) => <PersonChip key={id} id={id} onRemove={cell ? undefined : () => remove(id)} />)
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={empty ? undefined : label}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:hidden',
              empty ? (cell ? 'h-8 flex-1 px-1' : 'px-1.5') : 'w-6 justify-center',
              cell && !empty && 'opacity-0 group-hover/person:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            )}
          >
            {empty ? (
              !cell && (
                <>
                  <Plus className="size-3.5" /> Add someone
                </>
              )
            ) : field.many ? (
              <Plus className="size-3.5" />
            ) : (
              <PencilSimple className="size-3.5" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          {open && <PeoplePicker field={field} picked={ids} onPick={toggle} />}
          {ids.length > 0 && (cell || !field.many) && (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="flex h-8 w-full items-center border-t px-3 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Clear
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** The board's people, to pick from by name. Only built while its menu is open: a table has thousands of cells. */
function PeoplePicker({ field, picked, onPick }: { field: BoardField; picked: string[]; onPick: (id: string) => void }) {
  const { data } = useBoard()
  const [q, setQ] = useState('')
  const typed = q.trim().toLowerCase()
  const found = data.members.filter((m) => m.name.toLowerCase().includes(typed))
  return (
    <div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Name"
        aria-label={`Find someone for ${field.name}`}
        className="h-10 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <ul className="max-h-72 overflow-y-auto p-1" role="listbox" aria-label="People">
        {found.map((m) => {
          const on = picked.includes(m.id)
          return (
            <li key={m.id}>
              <button
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onPick(m.id)}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
              >
                <Avatar name={m.name} className="size-5 text-[9px]" />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {on && <Check weight="bold" className="size-3.5 shrink-0" />}
              </button>
            </li>
          )
        })}
        {!found.length && (
          <li className="px-2 py-2 text-sm text-muted-foreground">
            {typed ? `No one called “${q.trim()}” is on this board.` : 'Nobody is on this board yet.'}
          </li>
        )}
      </ul>
    </div>
  )
}
