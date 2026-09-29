import { ArrowLeft, PencilSimple } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import { useBoard } from '@/app/board-context'
import { ColorSwatches, LabelChip } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LABEL_COLOR_CYCLE, type ColorName } from '@kanbanto/model/colors'
import { newId } from '@kanbanto/model/ids'
import type { LabelDef } from '@kanbanto/model/types'

type Screen = { kind: 'list' } | { kind: 'edit'; label?: LabelDef }

/**
 * Trello-style labels: tick board labels on and off, search them, create new ones and edit them.
 * Editing a label changes it on every card that uses it.
 */
export function LabelPicker({ selected, onChange, trigger }: { selected: string[]; onChange: (ids: string[]) => void; trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>({ kind: 'list' })

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setScreen({ kind: 'list' })
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {screen.kind === 'list' ? (
          <LabelList selected={selected} onChange={onChange} onEdit={(label) => setScreen({ kind: 'edit', label })} />
        ) : (
          <LabelEditor
            label={screen.label}
            onDone={(created) => {
              if (created) onChange([...selected, created])
              setScreen({ kind: 'list' })
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function LabelList({ selected, onChange, onEdit }: { selected: string[]; onChange: (ids: string[]) => void; onEdit: (label?: LabelDef) => void }) {
  const { data } = useBoard()
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const labels = data.labels.filter((l) => !needle || l.name.toLowerCase().includes(needle))
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  return (
    <div className="p-3">
      <p className="mb-2 text-center text-sm font-medium">Labels</p>
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search labels…" className="h-8" />
      <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
        {labels.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            <Checkbox checked={selected.includes(l.id)} onCheckedChange={() => toggle(l.id)} aria-label={l.name || l.color} />
            <button onClick={() => toggle(l.id)} className="min-w-0 flex-1 rounded transition-[filter] hover:brightness-95">
              <LabelChip label={l} className="h-8 w-full px-3 text-xs" />
            </button>
            <button
              onClick={() => onEdit(l)}
              aria-label="Edit label"
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PencilSimple className="size-4" />
            </button>
          </li>
        ))}
        {labels.length === 0 && <li className="py-2 text-center text-xs text-muted-foreground">{needle ? 'No labels match.' : 'No labels yet.'}</li>}
      </ul>
      <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={() => onEdit(undefined)}>
        Create a new label
      </Button>
    </div>
  )
}

function LabelEditor({ label, onDone }: { label?: LabelDef; onDone: (createdId?: string) => void }) {
  const { data, run } = useBoard()
  const [name, setName] = useState(label?.name ?? '')
  const [color, setColor] = useState<ColorName>(label?.color ?? LABEL_COLOR_CYCLE[data.labels.length % LABEL_COLOR_CYCLE.length])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const uses = label ? Object.values(data.tasks).filter((t) => t.labels.includes(label.id)).length : 0

  const save = () => {
    if (label) {
      run({ type: 'label.update', id: label.id, fields: { name, color } })
      onDone()
    } else {
      const id = newId()
      run({ type: 'label.create', id, name, color })
      onDone(id)
    }
  }

  if (confirmDelete && label)
    return (
      <div className="space-y-3 p-3">
        <Header title="Delete label?" onBack={() => setConfirmDelete(false)} />
        <p className="text-sm text-muted-foreground">
          {uses ? `It will be removed from ${uses} ${uses === 1 ? 'card' : 'cards'}. ` : ''}This can’t be undone.
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => {
            run({ type: 'label.delete', id: label.id })
            onDone()
          }}
        >
          Delete label
        </Button>
      </div>
    )

  return (
    <form
      className="space-y-3 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <Header title={label ? 'Edit label' : 'Create label'} onBack={() => onDone()} />
      <div className="grid h-14 place-items-center rounded-md bg-muted/60 px-6">
        <LabelChip label={{ name, color }} className="h-8 w-full px-3 text-xs" />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Title</p>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Design" className="h-8" />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Color</p>
        <ColorSwatches value={color} onChange={(c) => c && setColor(c)} />
      </div>
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" className="flex-1">
          {label ? 'Save' : 'Create'}
        </Button>
        {label && (
          <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
      </div>
    </form>
  )
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="relative flex h-6 items-center justify-center">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="absolute left-0 grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
      </button>
      <p className="text-sm font-medium">{title}</p>
    </div>
  )
}
