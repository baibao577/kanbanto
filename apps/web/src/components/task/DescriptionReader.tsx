import { ArrowCounterClockwise, ChatCircleText, Check, ClockCounterClockwise, LinkSimple, PencilSimple } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DescriptionVersion } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { formatMoment } from '@/lib/format'
import type { CardRefs, CardSource } from '@/app/card-refs'
import type { CardComments } from '@/data/cardComments'
import type { CardFiles } from '@/data/cardFiles'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { placeAtPoint, type Place } from '@/components/text/caret'
import type { EditorHandle, Shared } from '@/components/text/Editor'
import { Markdown } from '@/components/text/Markdown'
import { countWords, headingsOf } from '@/components/text/mdText'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { copyText } from '@/lib/copy'
import { cn } from '@/lib/utils'
import { PassagePanel, SelectionButton } from './PassageNotes'
import { usePassages, type Pending } from './usePassages'

const Editor = lazy(() => import('@/components/text/Editor'))

/**
 * A description full page, to read or to write: a comfortable width and size, and (for long ones) its headings on the
 * side to jump to, which follow what's being typed. Writing here looks like the page it will be: no box around the
 * text, the toolbar staying in view. Esc (or Done) finishes writing; closing the page saves too.
 *
 * Comments on the text (`notes`): the words each is about are marked, the comments sit beside the text, and
 * selecting words while reading offers to comment on them (see PassageNotes.tsx).
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
  shared,
  opening,
  editorKey,
  typing,
  status,
  onTyped,
  onSave,
  onFinish,
  onEdit,
  onTick,
  onClose,
  link,
  note,
  versions,
  notes,
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
  /**
   * The text is written with other people at once (see Description, and the editor's `shared`). `opening`: joining
   * them hasn't been answered yet (a moment). `editorKey`: which shared document it is (the editor starts again with
   * another).
   */
  shared?: Shared
  opening?: boolean
  editorKey?: string | number
  /** What's being typed, a moment behind the keys (for the Contents and the word count). */
  typing: string
  /** Shown while writing, beside the word count: whether it's saved, and who else is writing. */
  status: ReactNode
  onTyped: (markdown: string, from?: 'local' | 'theirs') => void
  onSave: () => void
  onFinish: () => void
  /** Start writing, the cursor at this place in the text (see caret.ts); left out: at the end. */
  onEdit: (caret?: Place) => void
  onTick?: (n: number) => void
  onClose: () => void
  /** A link that opens the card with this page showing: there is a button to copy it. */
  link?: string
  /** Said above the text while reading (who is writing it at this moment). */
  note?: ReactNode
  /**
   * The text's earlier versions (see the server's boards/versions.ts): where they are read, and (`onRestore`, for
   * people who can edit) how one is brought back: the description becomes that text again, as a change like any
   * other. Left out: no Versions here (a visitor with the public link). `busy`: why none can be brought back just now.
   */
  versions?: { boardId: string; taskId: string; onRestore?: (text: string, said: string) => void; busy?: string }
  /**
   * The card's comments, of which the ones about words of this text are shown with it. `canComment`: this person
   * may add one. `focus`: the comment to open at (its words clicked in the card's Comments). Left out: none here.
   */
  notes?: { comments: CardComments; taskId: string; canComment: boolean; focus?: string | null }
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  /** What holds the text itself, read or written. */
  const words = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorHandle>(null)
  // Looking at earlier versions: the list (asked for when it opens), the one picked, and its text once it has come.
  const [looking, setPast] = useState<{ list: DescriptionVersion[] | null; picked?: DescriptionVersion; text?: string } | null>(null)
  // (Writing isn't done over an old version: while writing, they aren't shown.)
  const past = writing ? null : looking
  const at = versions && `/boards/${encodeURIComponent(versions.boardId)}/tasks/${encodeURIComponent(versions.taskId)}/versions`
  const openPast = () => {
    setPast({ list: null })
    api<{ versions: DescriptionVersion[] }>('GET', at!).then(
      (r) => setPast((p) => p && { ...p, list: r.versions }),
      () => setPast((p) => p && { ...p, list: [] }),
    )
  }
  const pick = (v: DescriptionVersion | undefined) => {
    setPast((p) => p && { list: p.list, picked: v })
    if (v)
      api<{ version: { text: string } }>('GET', `${at}/${v.id}`).then(
        (r) => setPast((p) => (p?.picked?.id === v.id ? { ...p, text: r.version.text } : p)),
        () => setPast((p) => (p?.picked?.id === v.id ? { list: p.list } : p)),
      )
  }
  const old = past?.picked && past.text !== undefined ? past.text : null
  const shown = writing ? typing : (old ?? value)
  const headings = useMemo(() => headingsOf(shown), [shown])
  const wordCount = useMemo(() => countWords(shown), [shown])

  // Comments on the text: which one is looked at, the words a new one is being written about, and whether they are
  // beside the text (by themselves when there are open ones and room for them, until the person says otherwise).
  const roomy = useMediaQuery('(min-width: 1280px)')
  const [beside, setBeside] = useState<boolean | null>(notes?.focus ? true : null)
  const [active, setActive] = useState<string | null>(notes?.focus ?? null)
  const [pending, setPending] = useState<Pending | null>(null)
  const openNotes = notes?.comments.threads.filter((t) => !t.root.resolved).length ?? 0
  const panel = !!notes && (beside ?? (roomy && openNotes > 0))
  const textRoot = () => words.current?.querySelector<HTMLElement>('.md-reader') ?? null
  const marks = usePassages({
    root: textRoot,
    threads: notes?.comments.threads ?? [],
    text: shown,
    active,
    pending,
    on: !!notes && !past?.picked,
  })
  /** Brings a comment's words into view in the text. */
  const showWords = (id: string) => {
    const range = marks.rangeOf(id)
    const view = scroller.current
    if (!range || !view) return
    const top = range.getBoundingClientRect().top - view.getBoundingClientRect().top
    view.scrollBy({ top: top - Math.min(160, view.clientHeight / 3), behavior: 'smooth' })
  }
  // Opened at a comment (its words were clicked in the card's Comments): its words come into view once they are found.
  const led = useRef(false)
  useEffect(() => {
    if (led.current || !notes?.focus || !marks.places) return
    led.current = true
    showWords(notes.focus)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, when the places are first known
  }, [marks.places])

  /** Writing starts where you were reading: at the top of what's in view (a short text: at its end). */
  const edit = () => {
    setPast(null)
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
                {wordCount.toLocaleString()} {wordCount === 1 ? 'word' : 'words'}
              </span>
              {status}
            </div>
          )}
          {notes && (
            <Button
              size="sm"
              variant={panel ? 'secondary' : 'ghost'}
              className={cn('gap-1.5', !panel && 'text-muted-foreground')}
              aria-pressed={panel}
              title="Comments on the text"
              onClick={() => setBeside(!panel)}
            >
              <ChatCircleText /> <span className="max-sm:sr-only">Comments</span>
              {openNotes > 0 && <span className="tabular-nums">{openNotes}</span>}
            </Button>
          )}
          {versions && !writing && (
            <Button
              size="sm"
              variant={past ? 'secondary' : 'ghost'}
              className={cn('gap-1.5', !past && 'text-muted-foreground')}
              aria-pressed={!!past}
              title="How this text read before"
              onClick={() => (past ? setPast(null) : openPast())}
            >
              <ClockCounterClockwise /> <span className="max-sm:sr-only">Versions</span>
            </Button>
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
        <div className="relative flex min-h-0 flex-1">
          {past && (
            <nav aria-label="Versions" className="hidden w-60 shrink-0 overflow-y-auto border-r bg-muted/30 px-3 py-6 lg:block">
              <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">Versions</p>
              <VersionList past={past} onPick={pick} />
            </nav>
          )}
          {!past && headings.length > 1 && (
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
          {/* (`@container`: how wide the page is, for a table too wide for the column of text: see index.css.) */}
          <div ref={scroller} className="@container min-h-0 flex-1 overflow-y-auto">
            <div
              ref={column}
              className="mx-auto max-w-[72ch] px-5 py-8 sm:px-8 sm:py-10"
              // A click on marked words, while reading, opens the comment they are about.
              onClick={(e) => {
                if (!notes || writing || window.getSelection()?.toString() || (e.target as HTMLElement).closest('a, input, button')) return
                const id = marks.at(e.clientX, e.clientY)
                if (!id) return
                setActive(id)
                setBeside(true)
              }}
            >
              {/* (A narrow screen has no side for the list: it is above the text.) */}
              {past && (
                <div className="mb-6 rounded-lg border bg-muted/30 p-2 lg:hidden">
                  <VersionList past={past} onPick={pick} />
                </div>
              )}
              {past?.picked && (
                <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    As it was saved on <span className="font-medium">{formatMoment(past.picked.at)}</span>
                    {past.picked.by ? `, by ${past.picked.by.name}` : ''}
                    {past.picked.via ? ` (through ${past.picked.via})` : ''}.
                  </span>
                  {versions?.onRestore && old !== null && old !== value && (
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        versions.onRestore!(old, `Brought back the text of ${formatMoment(past.picked!.at)}`)
                        setPast(null)
                      }}
                    >
                      <ArrowCounterClockwise /> Bring this version back
                    </Button>
                  )}
                  {old !== null && old === value && <span className="text-xs text-muted-foreground">This is how it reads now.</span>}
                  {old !== null && old !== value && versions?.busy && <span className="w-full text-xs text-muted-foreground">{versions.busy}</span>}
                </div>
              )}
              {note && !writing && !past && <div className="mb-4 text-xs text-muted-foreground">{note}</div>}
              <div ref={words}>
                {writing && opening ? null : writing ? (
                  <Suspense fallback={null}>
                    <Editor
                      key={editorKey}
                      look="page"
                      handle={editor}
                      value={start.text}
                      shared={shared}
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
                ) : past?.picked && old === null ? (
                  <p className="text-muted-foreground">Fetching that version…</p>
                ) : shown ? (
                  <Markdown
                    text={shown}
                    files={cardFiles.files}
                    mentions={people}
                    cards={cardRefs}
                    headingIds
                    onToggleTask={old === null ? onTick : undefined}
                    pictures
                    className="md-reader"
                  />
                ) : (
                  <p className="text-muted-foreground">{old !== null ? 'The description was empty then.' : 'No description yet.'}</p>
                )}
              </div>
            </div>
          </div>
          {panel && notes && (
            <PassagePanel
              // (Beside the text where there is room; over it on a narrow screen.)
              className="w-full shrink-0 border-l max-lg:absolute max-lg:inset-0 max-lg:z-10 max-lg:bg-background lg:w-[22rem]"
              comments={notes.comments}
              taskId={notes.taskId}
              cardFiles={cardFiles}
              places={marks.places}
              active={active}
              onActive={(id) => {
                setActive(id)
                showWords(id)
              }}
              pending={pending}
              onPending={setPending}
              onClose={() => setBeside(false)}
            />
          )}
          {notes?.canComment && !past?.picked && (
            <SelectionButton
              text={textRoot}
              onPick={(range, said) => {
                const picked = marks.selected(range, said)
                if (!picked) return
                // (Words selected while writing may have been typed a moment ago: they are saved now, so the
                // comment is about words everyone has.)
                if (writing) onSave()
                setPending(picked)
                setActive(null)
                setBeside(true)
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The text's versions, newest first, under "Now" (the text as it is): each says when it was saved and by whom. A
 * person's saves within a few minutes are one version.
 */
function VersionList({
  past,
  onPick,
}: {
  past: { list: DescriptionVersion[] | null; picked?: DescriptionVersion }
  onPick: (v: DescriptionVersion | undefined) => void
}) {
  const row = 'block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-foreground'
  if (!past.list) return <p className="px-2 text-sm text-muted-foreground">Fetching…</p>
  return (
    <ul className="space-y-0.5">
      <li>
        <button
          type="button"
          aria-current={!past.picked}
          onClick={() => onPick(undefined)}
          className={cn(row, !past.picked ? 'bg-accent font-medium' : 'text-muted-foreground')}
        >
          Now
        </button>
      </li>
      {past.list.map((v) => (
        <li key={v.id}>
          <button
            type="button"
            aria-current={past.picked?.id === v.id}
            onClick={() => onPick(v)}
            className={cn(row, past.picked?.id === v.id ? 'bg-accent font-medium' : 'text-muted-foreground')}
          >
            <span className="block tabular-nums">{formatMoment(v.at)}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {v.by?.name ?? 'Before versions were kept'}
              {v.via ? ` · through ${v.via}` : ''}
            </span>
          </button>
        </li>
      ))}
      {past.list.length === 0 && (
        <li className="px-2 pt-1 text-xs text-muted-foreground">No earlier versions yet. They are kept from the first time this text changes.</li>
      )}
    </ul>
  )
}
