import { Plus, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useReadOnly } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { TitleDateChip } from '@/components/text/TitleDate'
import { useTitleDate } from '@/components/text/useTitleDate'
import { cn } from '@/lib/utils'
import type { TaskFields } from '@kanbanto/model/commands'
import type { CardTemplate } from '@kanbanto/model/templates'
import { TemplateMenu } from '@/components/templates/TemplateMenu'

interface Props {
  /**
   * Called with the typed title. The field stays open for the next one, like Trello. With `dates`, a time typed in the
   * title comes as fields (due, maybe a reminder) and is taken out of the title.
   */
  onAdd: (title: string, fields?: TaskFields) => void
  /** Read a time from the title ("buy cat next monday 1pm"): for cards, not lists. */
  dates?: boolean
  label?: string
  placeholder?: string
  submitLabel?: string
  className?: string
  /** A single-line input instead of a textarea (for list names). */
  single?: boolean
  /** Drawn straight on the board background (uses its text colors). */
  onCanvas?: boolean
  /**
   * Each time this changes to something other than 0, the field opens with the cursor in it (a key that means "add
   * a card here"). Also when it's there from the start: the key was pressed before this was on the page.
   */
  focusSignal?: number
  /** The board's card templates: an arrow on the button starts the card from one of them (`onTemplate`) in place of typing it. */
  templates?: readonly CardTemplate[]
  onTemplate?: (template: CardTemplate) => void
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
  dates,
  focusSignal = 0,
  templates,
  onTemplate,
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  // The list of templates is open: the field has lost the cursor to it, and isn't closed for that.
  const picking = useRef(false)
  const readOnly = useReadOnly()
  const field = useRef<HTMLTextAreaElement>(null)
  const [signal, setSignal] = useState(0)
  if (signal !== focusSignal) {
    setSignal(focusSignal)
    if (focusSignal) setOpen(true)
  }
  // (Already open: the cursor goes back in it. Opening it puts the cursor there by itself.)
  useEffect(() => {
    if (focusSignal) field.current?.focus()
  }, [focusSignal])
  const date = useTitleDate(dates ? value : '')

  const submit = () => {
    const title = value.trim()
    if (!title) return
    const { title: rest, fields } = date.apply(title)
    onAdd(rest, fields)
    setValue('')
    date.reset()
  }
  const close = () => {
    setOpen(false)
    setValue('')
    date.reset()
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
    'w-full resize-none rounded-lg border border-input bg-(--tile) px-3 py-2 text-sm shadow-tile outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40'
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
          ref={field}
          autoFocus
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={keys}
          onBlur={() => !value.trim() && !picking.current && close()}
          className={fieldClass}
        />
      )}
      {dates && <TitleDateChip state={date} />}
      <div className="flex items-center gap-1">
        {/* mousedown keeps the field from blurring (and closing) before the click lands */}
        <span className="flex">
          <Button
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={submit}
            className={cn(templates?.length && onTemplate && 'rounded-r-none')}
          >
            {submitLabel}
          </Button>
          {templates && onTemplate && (
            <TemplateMenu
              templates={templates}
              onOpenChange={(o) => {
                picking.current = o
                // (Closed without choosing: back to the field, which closes again when left empty.)
                if (!o) requestAnimationFrame(() => field.current?.focus())
              }}
              onPick={(t) => {
                onTemplate(t)
                close()
              }}
            />
          )}
        </span>
        <Button size="icon" variant="ghost" className="size-8" onClick={close} aria-label="Cancel">
          <X />
        </Button>
      </div>
    </div>
  )
}
