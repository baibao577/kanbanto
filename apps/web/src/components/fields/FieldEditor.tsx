import { Archive, ArrowCounterClockwise, ArrowDown, ArrowUp, Plus, Trash, X } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { FieldLibraryView, FieldView } from '@kanbanto/model/api'
import { LABEL_COLOR_CYCLE, tone, type ColorName } from '@kanbanto/model/colors'
import { FIELD_LIMITS, FIELD_TYPE_HINT, FIELD_TYPE_LABEL, FIELD_TYPES, type FieldType, type TextFormat } from '@kanbanto/model/fields'
import { api, errorMessage } from '@/api/client'
import { ColorSwatches } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { FIELD_ICON, FORMAT_LABEL } from './meta'

type Option = { key: number; id?: string; name: string; color: ColorName; archived?: boolean }
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
  const [format, setFormat] = useState<TextFormat>(field?.format ?? 'plain')
  const [unit, setUnit] = useState(field?.unit ?? '')
  const [decimals, setDecimals] = useState(field?.decimals === undefined ? 'any' : String(field.decimals))
  const [sum, setSum] = useState(!!field?.sum)
  const [options, setOptions] = useState<Option[]>(() => (field?.options ?? []).map((o) => ({ key: ++keys, ...o })))
  const [deleted, setDeleted] = useState(0)
  const [busy, setBusy] = useState(false)

  const settings =
    type === 'text'
      ? { format }
      : type === 'number'
        ? { unit: unit.trim(), decimals: decimals === 'any' ? null : Number(decimals), sum }
        : type === 'choice'
          ? { options: options.filter((o) => o.name.trim()).map(({ key: _key, ...o }) => ({ ...o, name: o.name.trim() })) }
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
          <Button type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
            {field ? 'Save' : 'Add field'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
