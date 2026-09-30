import { ArrowsOut, PencilSimple, TextAlignLeft } from '@phosphor-icons/react'
import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react'
import type { CardFiles } from '@/data/cardFiles'
import { Markdown } from '@/components/text/Markdown'
import { toggleTask } from '@/components/text/mdText'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FILE_MARK } from './RichText'
import { Section } from './Section'

const Editor = lazy(() => import('@/components/text/Editor'))
const Reader = lazy(() => import('./DescriptionReader').then((m) => ({ default: m.DescriptionReader })))

/** Taller than this and it's shown folded, with "Show more". */
const FOLDED = 320

/**
 * The card's description: Markdown, shown formatted (long ones folded, with "Show more"; Expand reads it full page).
 * Clicked, it's edited in place; saved when you click away. Checklist items can be ticked without editing. Type # to
 * point to one of the card's files; files dropped or pasted in are attached and referenced where the cursor is.
 */
export function Description({
  title,
  value,
  readOnly,
  cardFiles,
  onSave,
}: {
  title: string
  value: string
  readOnly: boolean
  cardFiles: CardFiles
  onSave: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [reading, setReading] = useState(false)
  // What's being typed (only while editing: otherwise the saved text is shown, including others' changes).
  const draft = useRef(value)
  const edit = () => {
    if (readOnly) return
    draft.current = value
    setEditing(true)
  }
  const finish = () => {
    setEditing(false)
    if (draft.current !== value) onSave(draft.current)
  }
  const tick = readOnly ? undefined : (n: number) => onSave(toggleTask(value, n))

  const aside = value && !editing && (
    <div className="flex items-center gap-1">
      {!readOnly && (
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={edit}>
          <PencilSimple /> Edit
        </Button>
      )}
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => setReading(true)}>
        <ArrowsOut /> Expand
      </Button>
    </div>
  )

  return (
    <Section icon={<TextAlignLeft />} title="Description" aside={aside}>
      {editing ? (
        <Suspense fallback={<div className="min-h-24 rounded-lg border bg-background" />}>
          <Editor
            value={value}
            onChange={(md) => (draft.current = md)}
            onBlur={finish}
            onEscape={finish}
            files={cardFiles.files}
            onFiles={(fs) => cardFiles.add(fs)}
            autoFocus
            aria-label="Description"
            placeholder={`Add more detail… Type # to point to a file (${FILE_MARK}), or ## for a heading.`}
            className="min-h-24"
          />
        </Suspense>
      ) : value ? (
        <Folded onOpen={readOnly ? undefined : edit}>
          <Markdown text={value} files={cardFiles.files} onToggleTask={tick} />
        </Folded>
      ) : readOnly ? (
        <p className="text-sm text-muted-foreground">No description.</p>
      ) : (
        <button
          type="button"
          onClick={edit}
          className="block min-h-16 w-full rounded-lg bg-muted/60 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
        >
          Add more detail… Type # to point to a file.
        </button>
      )}
      {reading && (
        <Suspense fallback={null}>
          <Reader title={title} value={value} readOnly={readOnly} cardFiles={cardFiles} onSave={onSave} onClose={() => setReading(false)} />
        </Suspense>
      )}
    </Section>
  )
}

/**
 * Long text, folded to a few lines with a fade and "Show more". Clicking the text (not a link or checkbox) calls
 * `onOpen` (to edit).
 */
export function Folded({ children, onOpen, height = FOLDED }: { children: React.ReactNode; onOpen?: () => void; height?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const check = () => setLong(el.scrollHeight > height + 40)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])
  const folded = long && !open
  return (
    <div>
      <div
        ref={box}
        role={onOpen ? 'button' : undefined}
        tabIndex={onOpen ? 0 : undefined}
        onClick={(e) => {
          // Selecting text, or a link or checkbox, isn't asking to edit.
          if (!onOpen || window.getSelection()?.toString() || (e.target as HTMLElement).closest('a, input, button')) return
          onOpen()
        }}
        onKeyDown={(e) => onOpen && e.key === 'Enter' && e.target === e.currentTarget && (e.preventDefault(), onOpen())}
        style={folded ? { maxHeight: height } : undefined}
        className={cn(
          'relative overflow-hidden rounded-lg px-3 py-2',
          onOpen && 'cursor-text hover:bg-muted/50',
          folded && '[mask-image:linear-gradient(to_bottom,black_70%,transparent)]',
        )}
      >
        {children}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 px-3 text-xs font-medium text-primary hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
