import { Plus, X } from '@phosphor-icons/react'
import { useState } from 'react'
import { useReadOnly } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Props {
  /** Called with the typed title. The field stays open for the next one, like Trello. */
  onAdd: (title: string) => void
  label?: string
  placeholder?: string
  submitLabel?: string
  className?: string
  /** A single-line input instead of a textarea (for list names). */
  single?: boolean
  /** Drawn straight on the board background (uses its text colors). */
  onCanvas?: boolean
}

/** "+ Add a card" that turns into an inline field. */
export function QuickAdd({
  onAdd,
  label = 'Add a card',
  placeholder = 'What needs to be done?',
  submitLabel = 'Add card',
  className,
  single,
  onCanvas,
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const readOnly = useReadOnly()

  const submit = () => {
    const title = value.trim()
    if (!title) return
    onAdd(title)
    setValue('')
  }
  const close = () => {
    setOpen(false)
    setValue('')
  }

  if (readOnly) return null
  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm transition-colors',
          onCanvas ? 'text-(--canvas-fg) hover:bg-(--canvas-chip)' : 'text-muted-foreground hover:bg-lane-hover hover:text-foreground',
          className,
        )}
      >
        <Plus className="size-4" /> {label}
      </button>
    )

  const fieldClass =
    'w-full resize-none rounded-lg border border-input bg-(--tile) px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40'
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
    if (e.key === 'Escape') close()
  }

  return (
    <div className={cn('space-y-2', className)}>
      {single ? (
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={keys}
          onBlur={() => !value.trim() && close()}
          className={cn(fieldClass, 'h-9')}
        />
      ) : (
        <textarea
          autoFocus
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={keys}
          onBlur={() => !value.trim() && close()}
          className={fieldClass}
        />
      )}
      <div className="flex items-center gap-1">
        {/* mousedown keeps the field from blurring (and closing) before the click lands */}
        <Button size="sm" onMouseDown={(e) => e.preventDefault()} onClick={submit}>
          {submitLabel}
        </Button>
        <Button size="icon" variant="ghost" className="size-8" onClick={close} aria-label="Cancel">
          <X />
        </Button>
      </div>
    </div>
  )
}
