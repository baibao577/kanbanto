import { Archive, ArrowCounterClockwise, ArrowDown, ArrowUp, Plus, Trash, X } from '@phosphor-icons/react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { FieldLibraryView, FieldView } from '@kanbanto/model/api'
import { LABEL_COLOR_CYCLE, tone, type ColorName } from '@kanbanto/model/colors'
import {
  FIELD_LIMITS,
  FIELD_TYPE_HINT,
  FIELD_TYPE_LABEL,
  FIELD_TYPES,
  nameKey,
  type FieldType,
  type LinkScope,
  type TextFormat,
} from '@kanbanto/model/fields'
import { api, errorMessage } from '@/api/client'
import { ColorSwatches } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useBoards } from '@/data/useBoards'
import { useLoaded } from '@/data/useLoaded'
import { cn } from '@/lib/utils'
import { FIELD_ICON, FORMAT_LABEL } from './meta'

type Option = { key: number; id?: string; name: string; color: ColorName; archived?: boolean }
/** Whether one name is another with a word added before or after. */
const doubles = (longer: string, shorter: string) => longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`)
let keys = 0

/**
 * Adds a field to a library, or changes one. `base`: the library's address (`/fields` for your own,
 * `/workspaces/<id>/fields` for a workspace's). A field's type is chosen once. A choice's options are edited as one
 * list: a saved option is archived first (the cards that have it keep it), and only then deleted.
 */
export function FieldEditor({
  base,
  field,
  onClose,
  onSaved,
}: {
  base: string
  /** The field to change; none: a new one. */
  field?: FieldView
  onClose: () => void
  onSaved: (library: FieldLibraryView, id: string) => void
}) {
  const [name, setName] = useState(field?.name ?? '')
  const [type, setType] = useState<FieldType>(field?.type ?? 'text')
  // The library's other fields, to say so before saving when the name is taken, or doubles one that's there.
  const [library] = useLoaded<FieldLibraryView>(useCallback(() => api('GET', base), [base]))
  const key = nameKey(name)
  const rest = (library?.fields ?? []).filter((f) => f.id !== field?.id)
  const taken = key ? rest.find((f) => nameKey(f.name) === key) : undefined
  // ("Company" and "Company name", "Value" and "Deal value": one name with a word before or after the other.)
  const twin =
    !taken && key.length > 2
      ? rest.find((f) => !f.archivedAt && f.type === type && (doubles(key, nameKey(f.name)) || doubles(nameKey(f.name), key)))
      : undefined
  const [format, setFormat] = useState<TextFormat>(field?.format ?? 'plain')
  const [unit, setUnit] = useState(field?.unit ?? '')
  const [decimals, setDecimals] = useState(field?.decimals === undefined ? 'any' : String(field.decimals))
  const [sum, setSum] = useState(!!field?.sum)
  const [options, setOptions] = useState<Option[]>(() => (field?.options ?? []).map((o) => ({ key: ++keys, ...o })))
  const [deleted, setDeleted] = useState(0)
  const [busy, setBusy] = useState(false)
  // A card link: where its cards come from ("board:<id>" for one board), one or several, its name on the other card.
  const [from, setFrom] = useState<string>(field?.linkTo === 'board' ? `board:${field.board ?? ''}` : (field?.linkTo ?? 'space'))
  const [many, setMany] = useState(!!field?.many)
  const [back, setBack] = useState(field?.back ?? '')
  // The boards of this library's space: a workspace's, or your own.
  const workspace = base.match(/^\/workspaces\/([^/]+)\//)?.[1]
  const { boards } = useBoards()
  const near = (boards ?? []).filter((b) => !b.archivedAt && (workspace ? b.workspaceId === workspace : !b.workspaceId && b.role === 'owner'))
  const gone = from.startsWith('board:') && !near.some((b) => `board:${b.id}` === from)

  const settings =
    type === 'text'
      ? { format }
      : type === 'number'
        ? { unit: unit.trim(), decimals: decimals === 'any' ? null : Number(decimals), sum }
        : type === 'choice'
          ? { options: options.filter((o) => o.name.trim()).map(({ key: _key, ...o }) => ({ ...o, name: o.name.trim() })) }
          : type === 'link'
            ? {
                linkTo: (from.startsWith('board:') ? 'board' : from) as LinkScope,
                ...(from.startsWith('board:') && from.length > 6 && { board: from.slice(6) }),
                many,
                back: back.trim(),
              }
            : type === 'person'
              ? { many }
              : {}
  const save = async () => {
    setBusy(true)
    try {
      if (field) onSaved(await api<FieldLibraryView>('PATCH', `${base}/${field.id}`, { name, ...settings }), field.id)
      else {
        const made = await api<FieldLibraryView & { id: string }>('POST', base, { name, type, ...settings })
        onSaved(made, made.id)
      }
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const patch = (key: number, p: Partial<Option>) => setOptions((all) => all.map((o) => (o.key === key ? { ...o, ...p } : o)))
  const move = (i: number, by: -1 | 1) =>
    setOptions((all) => {
      const next = [...all]
      ;[next[i], next[i + by]] = [next[i + by], next[i]]
      return next
    })
  const drop = (o: Option) => {
    setOptions((all) => all.filter((x) => x.key !== o.key))
    if (o.id) setDeleted((n) => n + 1)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{field ? 'Change a field' : 'New field'}</DialogTitle>
          <DialogDescription>
            {field ? 'Every board that uses it gets the change.' : 'Something extra to fill in on cards. Boards choose which fields they use.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="field-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="field-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={FIELD_LIMITS.name}
              placeholder="Client, Amount, Stage…"
              autoFocus
            />
            {taken && (
              <p className="text-xs text-destructive">
                {taken.archivedAt
                  ? `There’s an archived field called “${taken.name}”. Restore it, or pick another name.`
                  : `There’s already a field called “${taken.name}” (${FIELD_TYPE_LABEL[taken.type].toLowerCase()}): boards can use that one.`}
              </p>
            )}
            {twin && (
              <p className="text-xs text-muted-foreground">
                There’s already “{twin.name}”, of the same kind. If this is for the same thing, use that one: a field means the same on every board
                that has it.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-sm font-medium">Kind</p>
            {field ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                {(() => {
                  const I = FIELD_ICON[field.type]
                  return <I className="size-4" />
                })()}
                {FIELD_TYPE_LABEL[field.type]}. A field’s kind can’t be changed.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Kind" className="grid gap-1.5">
                {FIELD_TYPES.map((t) => {
                  const I = FIELD_ICON[t]
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={type === t}
                      onClick={() => setType(t)}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-accent',
                        type === t && 'border-primary bg-primary/5 hover:bg-primary/5',
                      )}
                    >
                      <I className={cn('size-4 shrink-0 text-muted-foreground', type === t && 'text-primary')} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{FIELD_TYPE_LABEL[t]}</span>
                        <span className="block text-xs text-muted-foreground">{FIELD_TYPE_HINT[t]}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {type === 'text' && (
            <div className="space-y-1.5">
              <label htmlFor="field-format" className="text-sm font-medium">
                It holds
              </label>
              <Select value={format} onValueChange={(v) => setFormat(v as TextFormat)}>
                <SelectTrigger id="field-format" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FORMAT_LABEL) as TextFormat[]).map((f) => (
                    <SelectItem key={f} value={f}>
                      {FORMAT_LABEL[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Links, emails and phone numbers can be clicked.</p>
            </div>
          )}

          {type === 'number' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="field-unit" className="text-sm font-medium">
                    Unit
                  </label>
                  <Input id="field-unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={FIELD_LIMITS.unit} placeholder="฿, h, %" />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="field-decimals" className="text-sm font-medium">
                    Decimals
                  </label>
                  <Select value={decimals} onValueChange={setDecimals}>
                    <SelectTrigger id="field-decimals" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">As typed</SelectItem>
                      {[0, 1, 2, 3].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0 ? 'None (12)' : `${n} (12.${'5'.padEnd(n, '0')})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-start justify-between gap-3">
                <span>
                  <span className="block text-sm font-medium">It adds up</span>
                  <span className="block text-xs text-muted-foreground">
                    An amount or hours, where a total means something. Not a score or a room number.
                  </span>
                </span>
                <Switch checked={sum} onCheckedChange={setSum} aria-label="It adds up" />
              </label>
            </>
          )}

          {type === 'link' && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="field-from" className="text-sm font-medium">
                  Its cards come from
                </label>
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger id="field-from" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {near.map((b) => (
                      <SelectItem key={b.id} value={`board:${b.id}`}>
                        {b.name}
                      </SelectItem>
                    ))}
                    {gone && <SelectItem value={from}>A board that’s gone</SelectItem>}
                    <SelectItem value="space">{workspace ? 'Any board of this workspace' : 'Any of your own boards'}</SelectItem>
                    <SelectItem value="same">The board that uses this field</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {gone
                    ? 'The board its cards came from is gone, or you can’t open it: pick another.'
                    : from === 'same'
                      ? 'Each board that uses it links its own cards to each other: “Related to”, “Duplicate of”.'
                      : from === 'space'
                        ? 'Any card you can open there can be linked.'
                        : 'A deal’s Company, picked from the cards of your Companies board.'}
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">A card links to</p>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={many ? 'many' : 'one'}
                  onValueChange={(v) => v && setMany(v === 'many')}
                  className="w-full"
                  aria-label="A card links to"
                >
                  <ToggleGroupItem value="one" className="flex-1 text-xs">
                    One card
                  </ToggleGroupItem>
                  <ToggleGroupItem value="many" className="flex-1 text-xs">
                    Several cards
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="field-back" className="text-sm font-medium">
                  On the other card, call the list
                </label>
                <Input id="field-back" value={back} maxLength={FIELD_LIMITS.name} placeholder="Deals" onChange={(e) => setBack(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  The linked card lists the cards that point at it, under this name. Left empty, under the field’s name.
                </p>
              </div>
            </>
          )}

          {type === 'person' && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">A card has</p>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={many ? 'many' : 'one'}
                onValueChange={(v) => v && setMany(v === 'many')}
                className="w-full"
                aria-label="A card has"
              >
                <ToggleGroupItem value="one" className="flex-1 text-xs">
                  One person
                </ToggleGroupItem>
                <ToggleGroupItem value="many" className="flex-1 text-xs">
                  Several people
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                Picked from the people on the board: a reviewer, an account owner. Nobody is told when they’re put here: that’s what Assignee is for.
              </p>
            </div>
          )}

          {type === 'choice' && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Options</p>
              <ul className="space-y-1">
                {options.map((o, i) => (
                  <li key={o.key} className={cn('flex items-center gap-1', o.archived && 'opacity-60')}>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Colour of ${o.name || 'this option'}`}
                          className="size-6 shrink-0 rounded-md ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          style={{ backgroundColor: tone(o.color) }}
                        />
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64">
                        <ColorSwatches value={o.color} onChange={(c) => c && patch(o.key, { color: c })} />
                      </PopoverContent>
                    </Popover>
                    <Input
                      value={o.name}
                      onChange={(e) => patch(o.key, { name: e.target.value })}
                      maxLength={FIELD_LIMITS.name}
                      placeholder="Option"
                      aria-label="Option name"
                      disabled={o.archived}
                      className="h-8 min-w-0 flex-1"
                    />
                    <Button type="button" variant="ghost" size="icon-xs" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      title="Move down"
                      disabled={i === options.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    {!o.id ? (
                      <Button type="button" variant="ghost" size="icon-xs" title="Remove" onClick={() => drop(o)}>
                        <X />
                      </Button>
                    ) : o.archived ? (
                      <>
                        <Button type="button" variant="ghost" size="icon-xs" title="Bring back" onClick={() => patch(o.key, { archived: false })}>
                          <ArrowCounterClockwise />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          title="Delete for good"
                          className="text-destructive hover:text-destructive"
                          onClick={() => drop(o)}
                        >
                          <Trash />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        title="Archive: cards that have it keep it, nobody can pick it"
                        onClick={() => patch(o.key, { archived: true })}
                      >
                        <Archive />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                disabled={options.filter((o) => !o.archived).length >= FIELD_LIMITS.options}
                onClick={() =>
                  setOptions((all) => [...all, { key: ++keys, name: '', color: LABEL_COLOR_CYCLE[all.length % LABEL_COLOR_CYCLE.length] }])
                }
              >
                <Plus /> Add an option
              </Button>
              {deleted > 0 && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Saving clears {deleted === 1 ? 'the deleted option' : `the ${deleted} deleted options`} from the cards that have{' '}
                  {deleted === 1 ? 'it' : 'them'}. This can’t be undone.
                </p>
              )}
            </div>
          )}
          {/* (So Enter in a text box saves.) */}
          <button type="submit" hidden />
        </form>
        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !name.trim() || !!taken} onClick={() => void save()}>
            {field ? 'Save' : 'Add field'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
