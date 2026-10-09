import { CaretDown, CaretRight, ChatCircleText, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { quoteLine } from '@kanbanto/model/passages'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import type { CardComments, Thread } from '@/data/cardComments'
import type { CardFiles } from '@/data/cardFiles'
import { cn } from '@/lib/utils'
import { Composer, PassageThread } from './Comments'
import type { Pending } from './usePassages'

// Comments on the words of a description, on its full page: the words each open comment is about are marked in the
// text, the comments sit beside it in the order of the text, and selecting words offers to comment on them. (What a
// comment keeps of its words and how they are found again: the model's passages.ts. The marking: text/passages.ts.)

/**
 * The button that appears by words selected in the text ("Comment"), wherever the selection ends. `within`: the
 * element the words must be in. It keeps the selection while it is pressed, and hands it over.
 */
export function SelectionButton({ within, onPick }: { within: RefObject<HTMLElement | null>; onPick: (range: Range, words: string) => void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let pressed = false
    const look = () => {
      const el = within.current
      const sel = window.getSelection()
      if (!el || !sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return setAt(null)
      const range = sel.getRangeAt(0)
      if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return setAt(null)
      const rects = range.getClientRects()
      const first = rects[0] ?? range.getBoundingClientRect()
      const last = rects[rects.length - 1] ?? first
      const wide = 116
      const x = (left: number) => Math.max(8, Math.min(left, window.innerWidth - wide - 8))
      // Over the start of what is selected, where such buttons are looked for. Under its end where a finger
      // selects (the phone's own menu is over it), or when there is no room above.
      const above = first.top - 40
      if (!window.matchMedia('(pointer: coarse)').matches && above > 60) setAt({ x: x(first.left + first.width / 2 - wide / 2), y: above })
      else setAt({ x: x(last.right - 40), y: Math.min(last.bottom + 8, window.innerHeight - 44) })
    }
    // (Not while the words are still being dragged over; a moment after the selection stops changing otherwise, for
    // a phone's handles, which say nothing else.)
    const soon = () => {
      clearTimeout(timer)
      if (!pressed) timer = setTimeout(look, 250)
    }
    const down = () => {
      pressed = true
      setAt(null)
    }
    const up = () => {
      pressed = false
      clearTimeout(timer)
      timer = setTimeout(look, 10)
    }
    const hide = () => setAt(null)
    document.addEventListener('selectionchange', soon)
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    window.addEventListener('scroll', hide, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('selectionchange', soon)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointerup', up)
      window.removeEventListener('scroll', hide, true)
    }
  }, [within])
  if (!at) return null
  return (
    <Button
      size="sm"
      data-not-text
      className="fixed z-20 h-8 gap-1.5 shadow-lg"
      style={{ left: at.x, top: at.y }}
      // (Pressing it mustn't let go of the words, nor count as starting a new selection.)
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const sel = window.getSelection()
        if (!sel?.rangeCount) return setAt(null)
        onPick(sel.getRangeAt(0).cloneRange(), sel.toString())
        sel.removeAllRanges()
        setAt(null)
      }}
    >
      <ChatCircleText /> Comment
    </Button>
  )
}

/**
 * The comments on the text, beside it: the open ones in the order their words come in the text, then the ones whose
 * words the text no longer has, then the resolved ones, folded away. With `pending`, the box to write a new one in,
 * first, under the words it is about.
 */
export function PassagePanel({
  comments,
  taskId,
  cardFiles,
  places,
  active,
  onActive,
  pending,
  onPending,
  onClose,
  className,
}: {
  comments: CardComments
  taskId: string
  cardFiles: CardFiles
  /** Where each open comment's words are in the text (see `usePassages`). Null: not known (yet, or just now). */
  places: Map<string, { start: number; end: number }> | null
  active: string | null
  /** A comment is chosen here: show its words in the text. */
  onActive: (id: string) => void
  pending: Pending | null
  onPending: (p: Pending | null) => void
  onClose: () => void
  className?: string
}) {
  const { data, canComment } = useBoard()
  const [showResolved, setShowResolved] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const open = comments.threads.filter((t) => !t.root.resolved)
  const resolved = comments.threads.filter((t) => t.root.resolved)
  const there = open
    .filter((t) => !places || places.has(t.root.id))
    .sort((a, b) => (places?.get(a.root.id)?.start ?? 0) - (places?.get(b.root.id)?.start ?? 0))
  const gone = places ? open.filter((t) => !places.has(t.root.id)) : []
  // The one being looked at is brought into view.
  useEffect(() => {
    if (active) box.current?.querySelector(`[data-thread="${active}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [active])
  const thread = (t: Thread, isGone = false) => (
    <li key={t.root.id}>
      <PassageThread
        thread={t}
        comments={comments}
        taskId={taskId}
        cardFiles={cardFiles}
        gone={isGone}
        active={active === t.root.id}
        onOpen={isGone ? undefined : () => onActive(t.root.id)}
      />
    </li>
  )
  return (
    <aside aria-label="Comments on the text" className={cn('flex min-h-0 flex-col bg-muted/30', className)}>
      <header className="flex h-11 shrink-0 items-center gap-2 px-4">
        <p className="flex-1 text-xs font-medium text-muted-foreground">Comments on the text</p>
        <button
          type="button"
          aria-label="Close the comments"
          onClick={onClose}
          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>
      <div ref={box} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-6">
        {pending && (
          <div className="rounded-lg border border-primary/40 bg-background p-2.5 ring-2 ring-primary/15">
            <p className="line-clamp-3 border-l-2 border-primary/60 pl-2 text-xs text-muted-foreground italic">
              {quoteLine(pending.passage.quote, 220)}
            </p>
            <div className="mt-2">
              <Composer
                boardId={data.board.id}
                taskId={taskId}
                members={data.members}
                files={cardFiles.files}
                start
                onSubmit={async (body, mentions, attachments) => {
                  const made = await comments.post(body, mentions, attachments, { passage: pending.passage })
                  onPending(null)
                  onActive(made.id)
                }}
                onCancel={() => onPending(null)}
                placeholder="Comment on these words… @ to mention someone."
                submitLabel="Comment"
              />
            </div>
          </div>
        )}
        {!pending && !open.length && !resolved.length && (
          <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            {canComment ? 'Nothing yet. Select some words in the text, and click Comment.' : 'No comments on the text.'}
          </p>
        )}
        <ul className="space-y-3">{there.map((t) => thread(t))}</ul>
        {gone.length > 0 && (
          <section>
            <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">No longer in the text</p>
            <ul className="space-y-3">{gone.map((t) => thread(t, true))}</ul>
          </section>
        )}
        {resolved.length > 0 && (
          <section>
            <button
              type="button"
              aria-expanded={showResolved}
              onClick={() => setShowResolved((s) => !s)}
              className="mb-2 flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {showResolved ? <CaretDown className="size-3" /> : <CaretRight className="size-3" />} Resolved ({resolved.length})
            </button>
            {showResolved && <ul className="space-y-3">{resolved.map((t) => thread(t))}</ul>}
          </section>
        )}
      </div>
    </aside>
  )
}
