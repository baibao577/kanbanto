import { Archive, Check, LinkSimple, Lock, PencilSimple, Plus, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { LinkPick } from '@kanbanto/model/api'
import { linksOf, type BoardField, type FieldValue } from '@kanbanto/model/fields'
import { api } from '@/api/client'
import { useLinked, useLinks } from '@/app/links-context'
import { StatusDot } from '@/components/common/bits'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** A linked card that can't be named: it was deleted, or it's on a board this person can't open. */
const GONE = 'A deleted card'
const HIDDEN = 'A card you can’t open'

const CHIP = 'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-card px-1.5 text-xs'

/**
 * A linked card, as a chip: its list's dot and its title. Click it to open the card (on another board: in place, to
 * look). `onRemove`: an ✕ that takes the link away. `plain`: just shown, not a button.
 */
export function LinkChip({ link, onRemove, plain }: { link: string; onRemove?: () => void; plain?: boolean }) {
  const links = useLinks()
  const card = useLinked(link)
  if (!card)
    return (
      <span className={cn(CHIP, 'text-muted-foreground')} aria-busy>
        …
      </span>
    )
  const named = 'title' in card
  const body = named ? (
    <>
      {card.kind ? <StatusDot category={card.kind} /> : <Archive className="size-3 shrink-0" aria-label="Archived" />}
      <span className={cn('truncate', (card.done || card.archived) && 'text-muted-foreground')}>{card.title}</span>
    </>
  ) : (
    <>
      {'hidden' in card && <Lock className="size-3 shrink-0" />}
      <span className="truncate italic">{'gone' in card ? GONE : HIDDEN}</span>
    </>
  )
  const title = named ? [card.title, card.board.name, card.archived ? 'archived' : card.list].filter(Boolean).join(' · ') : undefined
  return (
    <span className={cn(CHIP, !named && 'border-dashed text-muted-foreground', onRemove && 'pr-0.5')} title={title}>
      {named && !plain ? (
        <button type="button" onClick={() => links?.open(link)} className="flex min-w-0 items-center gap-1.5 hover:underline">
          {body}
        </button>
      ) : (
        body
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={named ? `Remove the link to ${card.title}` : 'Remove this link'}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/** A card link on a card front: the field's name and its first card's title ("+2" for more). Not a button: the card is. */
export function LinkFront({ field, value }: { field: BoardField; value: FieldValue }) {
  const refs = linksOf(value)
  const first = useLinked(refs[0] ?? '')
  if (!refs.length) return null
  const title = first && 'title' in first ? first.title : refs.length === 1 ? '1 card' : null
  return (
    <span
      className="inline-flex h-5 max-w-full items-center gap-1 rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground"
      title={`${field.name}: ${title ?? `${refs.length} cards`}`}
    >
      <LinkSimple className="size-3 shrink-0 opacity-70" />
      <span className="truncate text-foreground/85">{title ?? `${refs.length} cards`}</span>
      {title && refs.length > 1 && <span className="shrink-0 tabular-nums">+{refs.length - 1}</span>}
    </span>
  )
}

/** A card link's cards, just shown (a viewer's card or Outline): chips that open their cards. */
export function LinkValueText({ value, cell }: { value: FieldValue | undefined; cell?: boolean }) {
  const refs = linksOf(value)
  if (!refs.length) return null
  return (
    <span className={cn('flex min-w-0 gap-1 px-1', cell ? 'overflow-hidden' : 'flex-wrap py-1')}>
      {refs.map((r) => (
        <LinkChip key={r} link={r} />
      ))}
    </span>
  )
}

/**
 * A card link's cards, edited in place: chips, and a picker that finds cards by their title. One card, or several
 * when the field holds several. In an Outline cell (`cell`) the chips stay on one line and the picker's button shows
 * when you point at the cell. A link whose card was deleted goes with the next change.
 */
export function LinkValueEditor({
  field,
  value,
  onChange,
  cell,
  taskId,
}: {
  field: BoardField
  value: FieldValue | undefined
  onChange: (v: FieldValue | null) => void
  cell?: boolean
  taskId?: string
}) {
  const links = useLinks()
  const refs = linksOf(value)
  const [open, setOpen] = useState(false)
  // (Deleted cards' links aren't carried into a new value. Ones this person can't open always are.)
  const kept = () =>
    refs.filter((r) => {
      const card = links?.store.get(r)
      return !(card && 'gone' in card)
    })
  const set = (next: string[]) => onChange(next.length ? next : null)
  const remove = (ref: string) => set(kept().filter((r) => r !== ref))
  const toggle = (pick: LinkPick) => {
    links?.store.learn({ [pick.ref]: { title: pick.title, board: pick.board, list: pick.list, kind: pick.kind, done: pick.done } })
    if (refs.includes(pick.ref)) return remove(pick.ref)
    set(field.many ? [...kept(), pick.ref] : [pick.ref])
    if (!field.many) setOpen(false)
  }
  const empty = !refs.length
  const label = empty ? `Add a card to ${field.name}` : field.many ? `Add another card to ${field.name}` : `Change ${field.name}`
  return (
    <div className={cn('group/link flex min-w-0 items-center gap-1 px-1', cell ? 'h-8' : 'min-h-8 flex-wrap py-1')}>
      {refs.map((r) => (
        <LinkChip key={r} link={r} onRemove={cell ? undefined : () => remove(r)} />
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={empty ? undefined : label}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:hidden',
              empty ? (cell ? 'h-8 flex-1 px-1' : 'px-1.5') : 'w-6 justify-center',
              cell && !empty && 'opacity-0 group-hover/link:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
            )}
          >
            {empty ? (
              !cell && (
                <>
                  <Plus className="size-3.5" /> Add a card
                </>
              )
            ) : field.many ? (
              <Plus className="size-3.5" />
            ) : (
              <PencilSimple className="size-3.5" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          {open && links && <LinkPicker boardId={links.store.boardId} field={field} taskId={taskId} picked={refs} onPick={toggle} />}
          {cell && refs.length > 0 && (
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

/** Finds cards for a link field by their title: the ones the field allows, as far as this person can open them. */
function LinkPicker({
  boardId,
  field,
  taskId,
  picked,
  onPick,
}: {
  boardId: string
  field: BoardField
  taskId?: string
  picked: string[]
  onPick: (card: LinkPick) => void
}) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<{ cards: LinkPick[]; problem?: string } | null>(null)
  useEffect(() => {
    let alive = true
    const t = setTimeout(
      () =>
        api<{ cards: LinkPick[]; problem?: string }>(
          'GET',
          `/boards/${encodeURIComponent(boardId)}/fields/${field.id}/cards?q=${encodeURIComponent(q.trim())}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`,
        ).then(
          (r) => alive && setFound(r),
          () => alive && setFound({ cards: [], problem: 'Couldn’t look for cards just now.' }),
        ),
      q ? 150 : 0,
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [boardId, field.id, taskId, q])
  // The other board's name under a title only says something when cards can come from several.
  const several = new Set(found?.cards.map((c) => c.board.id)).size > 1 || (field.linkTo ?? 'space') === 'space'
  return (
    <div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a card by its title"
        aria-label={`Find a card for ${field.name}`}
        className="h-10 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <ul className="max-h-72 overflow-y-auto p-1" role="listbox" aria-label="Cards">
        {found?.cards.map((c) => {
          const on = picked.includes(c.ref)
          const where = [...(several ? [c.board.name] : []), ...c.path].join(' › ')
          return (
            <li key={c.ref}>
              <button
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onPick(c)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <StatusDot category={c.kind} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', c.done && 'text-muted-foreground')}>{c.title}</span>
                  {where && <span className="block truncate text-xs text-muted-foreground">{where}</span>}
                </span>
                {on && <Check weight="bold" className="size-3.5 shrink-0" />}
              </button>
            </li>
          )
        })}
        {found && !found.cards.length && (
          <li className="px-2 py-2 text-sm text-muted-foreground">{found.problem ?? (q.trim() ? 'No cards found.' : 'No cards to pick yet.')}</li>
        )}
        {!found && <li className="px-2 py-2 text-sm text-muted-foreground">Looking…</li>}
      </ul>
    </div>
  )
}
