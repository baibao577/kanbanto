import { Check, PencilSimple } from '@phosphor-icons/react'
import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import type { CardFiles } from '@/data/cardFiles'
import { Markdown } from '@/components/text/Markdown'
import { headingsOf } from '@/components/text/mdText'
import { toggleTask } from '@/components/text/mdText'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const Editor = lazy(() => import('@/components/text/Editor'))

/**
 * A description read full page: a comfortable width and size, and (for long ones) its headings on the side to jump
 * to. It can be edited here too; closing saves.
 */
export function DescriptionReader({
  title,
  value,
  readOnly,
  cardFiles,
  onSave,
  onClose,
}: {
  title: string
  value: string
  readOnly: boolean
  cardFiles: CardFiles
  onSave: (text: string) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const draft = useRef(value)
  const scroller = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => headingsOf(value), [value])
  const save = () => {
    if (editing && draft.current !== value) onSave(draft.current)
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return
        save()
        onClose()
      }}
    >
      <DialogContent className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 pr-12 sm:px-6 sm:pr-14">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">{title}</DialogTitle>
            <DialogDescription className="sr-only">The task’s description, full page.</DialogDescription>
          </div>
          {!readOnly &&
            (editing ? (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  save()
                  setEditing(false)
                }}
              >
                <Check /> Done
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  draft.current = value
                  setEditing(true)
                }}
              >
                <PencilSimple /> Edit
              </Button>
            ))}
        </header>
        <div className="flex min-h-0 flex-1">
          {headings.length > 1 && !editing && (
            <nav aria-label="Contents" className="hidden w-60 shrink-0 overflow-y-auto border-r bg-muted/30 px-3 py-6 lg:block">
              <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">Contents</p>
              <ul className="space-y-0.5">
                {headings.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => scroller.current?.querySelector(`#${h.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      className={cn(
                        'block w-full truncate rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground',
                        h.depth > 1 && 'pl-5 text-[13px]',
                        h.depth > 2 && 'pl-8',
                      )}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[72ch] px-5 py-8 sm:px-8 sm:py-10">
              {editing ? (
                <Suspense fallback={null}>
                  <Editor
                    value={value}
                    onChange={(md) => (draft.current = md)}
                    files={cardFiles.files}
                    onFiles={(fs) => cardFiles.add(fs)}
                    autoFocus
                    aria-label="Description"
                    className="md-reader min-h-[50vh]"
                  />
                </Suspense>
              ) : value ? (
                <Markdown
                  text={value}
                  files={cardFiles.files}
                  headingIds
                  onToggleTask={readOnly ? undefined : (n) => onSave(toggleTask(value, n))}
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
