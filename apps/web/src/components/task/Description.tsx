import { ArrowsOut, PencilSimple, TextAlignLeft } from '@phosphor-icons/react'
import { formatDistanceToNow } from 'date-fns'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCardRefs, useCardSource } from '@/app/card-refs'
import type { CardFiles } from '@/data/cardFiles'
import { clearDraft, pruneDrafts, readDraft, writeDraft, type Draft } from '@/data/drafts'
import { placeAtPoint, type Place } from '@/components/text/caret'
import { Markdown } from '@/components/text/Markdown'
import { toggleTask } from '@/components/text/mdText'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FILE_MARK } from './RichText'
import { SaveSign } from './SaveSign'
import { Section } from './Section'

const Editor = lazy(() => import('@/components/text/Editor'))
const Page = lazy(() => import('./DescriptionReader').then((m) => ({ default: m.DescriptionReader })))

/** Taller than this and it's shown folded, with "Show more". */
const FOLDED = 320
/** How long after the last key the draft is put away (and the Contents and word count catch up). */
const SETTLE_MS = 300

pruneDrafts()

/**
 * The card's description: Markdown, shown formatted (long ones folded, with "Show more"). Clicked, it's written in
 * place, the cursor where you clicked; Expand reads or writes it full page, carrying on from where you were.
 *
 * What's typed is saved when you finish (clicking away, Esc, ⌘Enter) or with ⌘S, and kept as a draft in this browser
 * until then: a reload or a closed tab doesn't lose it, and it's offered back. Checklist items can be ticked without
 * editing. Type @ to mention someone on the board (they're told, once), # to point to one of the card's files, / for
 * things to put in; files dropped or pasted in are attached and referenced where the cursor is.
 */
export function Description({
  title,
  value,
  readOnly,
  cardFiles,
  people,
  draftId,
  onSave,
}: {
  title: string
  value: string
  readOnly: boolean
  cardFiles: CardFiles
  /** The board's people, suggested after "@". */
  people: { id: string; name: string; picture?: string | null }[]
  /** What its draft is kept under: the board and the card. */
  draftId: string
  onSave: (text: string) => void
}) {
  // The cards its text names (WEB-12), shown as links, and the ones "/" → Card offers.
  const cardRefs = useCardRefs()
  const cardSource = useCardSource()
  /** Where it's being written: in the card, full page, or not at all. */
  const [writing, setWriting] = useState<'card' | 'page' | null>(null)
  const [page, setPage] = useState(false)
  /** What the editor opens with: the text, and where the cursor goes. */
  const [start, setStart] = useState<{ text: string; caret?: Place }>({ text: value })
  const [dirty, setDirty] = useState(false)
  /** What's being typed, a moment behind the keys (the page's Contents and word count). */
  const [settled, setSettled] = useState(value)
  /** Writing left unsaved earlier (a reload, a closed tab), to offer back. */
  const [left, setLeft] = useState<Draft | null>(() => {
    const d = readOnly ? null : readDraft(draftId)
    return d && d.text !== value ? d : null
  })

  // The latest of each, for handlers that outlive a render (blur while leaving, the timer, closing the card).
  const text = useRef(value)
  const where = useRef<'card' | 'page' | null>(null)
  const saved = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useLayoutEffect(() => {
    saved.current = value
  })

  const begin = (at: 'card' | 'page', from: { text?: string; caret?: Place } = {}) => {
    if (readOnly) return
    // (Writing left unsaved earlier carries on from there, whichever way it's opened.)
    text.current = from.text ?? left?.text ?? value
    where.current = at
    setStart({ text: text.current, caret: from.caret })
    setDirty(text.current !== value)
    setSettled(text.current)
    setLeft(null)
    setWriting(at)
    if (at === 'page') setPage(true)
  }
  const typed = (md: string) => {
    text.current = md
    setDirty(md !== saved.current)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (md !== saved.current) writeDraft(draftId, md)
      setSettled(md)
    }, SETTLE_MS)
  }
  /** Saves what's typed (and stays, when called from the keyboard). */
  const save = () => {
    clearTimeout(timer.current)
    if (text.current !== saved.current) onSave(text.current)
    clearDraft(draftId)
    setDirty(false)
    setSettled(text.current)
  }
  const finish = () => {
    if (!where.current) return
    where.current = null
    save()
    setWriting(null)
  }
  /** From the card's editor to the full page, with the same text and cursor. */
  const toPage = (caret: Place) => {
    clearTimeout(timer.current)
    where.current = 'page'
    setStart({ text: text.current, caret })
    setSettled(text.current)
    setWriting('page')
    setPage(true)
  }
  const closePage = () => {
    if (where.current === 'page') finish()
    setPage(false)
  }
  const discard = () => {
    clearDraft(draftId)
    setLeft(null)
  }

  // Closing the card some other way while writing (Back, another card): the draft stays, to offer back.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      if (where.current && text.current !== saved.current) writeDraft(draftId, text.current)
    },
    [draftId],
  )

  const tick = readOnly ? undefined : (n: number) => onSave(toggleTask(value, n))
  const canExpand = !!value || !readOnly

  const aside = writing !== 'card' && (
    <div className="flex items-center gap-1">
      {!readOnly && value && (
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => begin('card')}>
          <PencilSimple /> Edit
        </Button>
      )}
      {canExpand && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          // With nothing to read yet, the full page opens ready to write.
          onClick={() => (value ? setPage(true) : begin('page'))}
        >
          <ArrowsOut /> Expand
        </Button>
      )}
    </div>
  )

  return (
    <Section icon={<TextAlignLeft />} title="Description" aside={aside}>
      {left && !writing && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">You were writing here {formatDistanceToNow(left.at, { addSuffix: true })}, and it wasn’t saved.</span>
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => begin('card')}>
            Continue writing
          </button>
          <button type="button" className="font-medium text-muted-foreground hover:text-foreground hover:underline" onClick={discard}>
            Discard
          </button>
        </div>
      )}
      {writing === 'card' ? (
        <Suspense fallback={<div className="min-h-24 rounded-lg border bg-background" />}>
          <Editor
            value={start.text}
            caret={start.caret}
            onChange={typed}
            // (Going full page takes the cursor out of here too: that isn't finishing.)
            onBlur={() => where.current === 'card' && finish()}
            onEscape={finish}
            onSubmit={finish}
            onSave={save}
            members={people}
            files={cardFiles.files}
            onFiles={(fs) => cardFiles.add(fs)}
            inserts
            cards={cardSource}
            status={<SaveSign dirty={dirty} />}
            onExpand={toPage}
            autoFocus
            aria-label="Description"
            placeholder={`Add more detail… Type / for headings, lists, tables and cards, @ to mention someone, # to point to a file (${FILE_MARK}).`}
            className="min-h-24"
            // It grows with the text up to half the window, then scrolls: the rest of the card stays in reach.
            scrollClassName="max-h-[50vh] overflow-y-auto"
          />
        </Suspense>
      ) : value ? (
        <Folded onOpen={readOnly ? undefined : (caret) => begin('card', { caret })}>
          <Markdown text={value} files={cardFiles.files} mentions={people} cards={cardRefs} onToggleTask={tick} />
        </Folded>
      ) : readOnly ? (
        <p className="text-sm text-muted-foreground">No description.</p>
      ) : (
        <button
          type="button"
          onClick={() => begin('card')}
          className="block min-h-16 w-full rounded-lg bg-muted/60 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
        >
          Add more detail… Type / for headings, lists and tables.
        </button>
      )}
      {page && (
        <Suspense fallback={null}>
          <Page
            people={people}
            title={title}
            value={value}
            readOnly={readOnly}
            cardFiles={cardFiles}
            cardRefs={cardRefs}
            cardSource={cardSource}
            writing={writing === 'page'}
            start={start}
            typing={settled}
            dirty={dirty}
            onTyped={typed}
            onSave={save}
            onFinish={finish}
            onEdit={(caret) => begin('page', { caret })}
            onTick={tick}
            onClose={closePage}
          />
        </Suspense>
      )}
    </Section>
  )
}

/**
 * Long text, folded to a few lines with a fade and "Show more". Clicking the text (not a link or checkbox) calls
 * `onOpen` (to edit), with the place in the text that was clicked (see caret.ts).
 */
export function Folded({ children, onOpen, height = FOLDED }: { children: React.ReactNode; onOpen?: (caret?: Place) => void; height?: number }) {
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
          onOpen(placeAtPoint(e.currentTarget, e.clientX, e.clientY) ?? undefined)
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
