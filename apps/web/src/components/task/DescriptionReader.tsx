import { Check, LinkSimple, PencilSimple } from '@phosphor-icons/react'
import { lazy, Suspense, useMemo, useRef } from 'react'
import type { CardRefs, CardSource } from '@/app/card-refs'
import type { CardFiles } from '@/data/cardFiles'
import { placeAtPoint, type Place } from '@/components/text/caret'
import type { EditorHandle } from '@/components/text/Editor'
import { Markdown } from '@/components/text/Markdown'
import { countWords, headingsOf } from '@/components/text/mdText'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { copyText } from '@/lib/copy'
import { cn } from '@/lib/utils'
import { SaveSign } from './SaveSign'

const Editor = lazy(() => import('@/components/text/Editor'))

/**
 * A description full page, to read or to write: a comfortable width and size, and (for long ones) its headings on the
 * side to jump to, which follow what's being typed. Writing here looks like the page it will be: no box around the
 * text, the toolbar staying in view. Esc (or Done) finishes writing; closing the page saves too.
 *
 * `Description` holds what's being written (so going full page from the card carries on with the same text and
 * cursor): this shows it.
 */
export function DescriptionReader({
  title,
  value,
  readOnly,
  cardFiles,
  cardRefs,
  cardSource,
  people,
  writing,
  start,
  typing,
  dirty,
  onTyped,
  onSave,
  onFinish,
  onEdit,
  onTick,
  onClose,
  link,
}: {
  title: string
  /** The saved text (what's read). */
  value: string
  readOnly: boolean
  cardFiles: CardFiles
  /** The cards the text names, and the ones "/" → Card offers (see app/card-refs). */
  cardRefs?: CardRefs
  cardSource?: CardSource
  people: { id: string; name: string; picture?: string | null }[]
  writing: boolean
  /** What the editor opens with: the text, and where the cursor goes. */
  start: { text: string; caret?: Place }
  /** What's being typed, a moment behind the keys (for the Contents and the word count). */
  typing: string
  dirty: boolean
  onTyped: (markdown: string) => void
  onSave: () => void
  onFinish: () => void
  /** Start writing, the cursor at this place in the text (see caret.ts); left out: at the end. */
  onEdit: (caret?: Place) => void
  onTick?: (n: number) => void
  onClose: () => void
  /** A link that opens the card with this page showing: there is a button to copy it. */
  link?: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorHandle>(null)
  const shown = writing ? typing : value
  const headings = useMemo(() => headingsOf(shown), [shown])
  const words = useMemo(() => countWords(shown), [shown])

  /** Writing starts where you were reading: at the top of what's in view (a short text: at its end). */
  const edit = () => {
    const view = scroller.current
    const text = column.current
    if (!view || !text || view.scrollHeight <= view.clientHeight + 8) return onEdit()
    const box = text.getBoundingClientRect()
    const top = view.getBoundingClientRect().top
    onEdit(placeAtPoint(text, box.left + 40, Math.max(top, box.top) + 48) ?? undefined)
  }
  const jump = (i: number, id: string) =>
    writing ? editor.current?.toHeading(i) : scroller.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none"
        // (Esc while writing finishes the writing: the editor sees to it. The next one closes the page.)
        // Opening to write puts the cursor in the text itself.
        // Opening to read puts it on the page itself (to scroll with the keys), not on its first button.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (!writing) (e.currentTarget as HTMLElement).focus()
        }}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 pr-12 sm:px-6 sm:pr-14">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">{title}</DialogTitle>
            <DialogDescription className="sr-only">The task’s description, full page.</DialogDescription>
          </div>
          {writing && (
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="tabular-nums max-sm:hidden">
                {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
              </span>
              <SaveSign dirty={dirty} />
            </div>
          )}
          {link && !writing && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              title="Copy a link that opens this page"
              onClick={() => void copyText(link, 'Link')}
            >
              <LinkSimple /> <span className="max-sm:sr-only">Copy link</span>
            </Button>
          )}
          {!readOnly &&
            (writing ? (
              <Button size="sm" className="gap-1.5" onClick={onFinish}>
                <Check /> Done
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={edit}>
                <PencilSimple /> Edit
              </Button>
            ))}
        </header>
        <div className="flex min-h-0 flex-1">
          {headings.length > 1 && (
            <nav aria-label="Contents" className="hidden w-60 shrink-0 overflow-y-auto border-r bg-muted/30 px-3 py-6 lg:block">
              <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">Contents</p>
              <ul className="space-y-0.5">
                {headings.map((h, i) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      // (Keeps the cursor in the text while writing.)
                      onMouseDown={(e) => writing && e.preventDefault()}
                      onClick={() => jump(i, h.id)}
                      className={cn(
                        'block w-full truncate rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground',
                        h.depth > 1 && 'pl-5 text-[13px]',
                        h.depth > 2 && 'pl-8',
                      )}
                    >
                      {h.text || 'Untitled'}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div ref={column} className="mx-auto max-w-[72ch] px-5 py-8 sm:px-8 sm:py-10">
              {writing ? (
                <Suspense fallback={null}>
                  <Editor
                    look="page"
                    handle={editor}
                    value={start.text}
                    caret={start.caret}
                    onChange={onTyped}
                    onEscape={onFinish}
                    onSubmit={onFinish}
                    onSave={onSave}
                    members={people}
                    files={cardFiles.files}
                    onFiles={(fs) => cardFiles.add(fs)}
                    inserts
                    cards={cardSource}
                    pictures
                    autoFocus
                    aria-label="Description"
                    placeholder="Write here… Type / for headings, lists, tables and cards, @ to mention someone, # to point to a file."
                    className="md-reader min-h-[50vh]"
                  />
                </Suspense>
              ) : value ? (
                <Markdown
                  text={value}
                  files={cardFiles.files}
                  mentions={people}
                  cards={cardRefs}
                  headingIds
                  onToggleTask={onTick}
                  pictures
                  className="md-reader"
                />
              ) : (
                <p className="text-muted-foreground">No description yet.</p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
