import { CheckCircle, Circle, ListChecks, Prohibit, X } from '@phosphor-icons/react'
import { formatMoment } from '@/lib/format'
import { changedAt } from '@kanbanto/model/table'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BoardContext, useBoard } from '@/app/board-context'
import { hrefFor, setFullPage, wantsFullPage } from '@/app/router'
import { ProgressBar, StatusDot, StatusPill } from '@/components/common/bits'
import { QuickAdd } from '@/components/board/QuickAdd'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { indexFor, statusCol } from '@kanbanto/model/indexer'
import type { TaskFields } from '@kanbanto/model/commands'
import { EPOCH } from '@kanbanto/model/types'
import { ArchivedBanner } from './ArchivedTask'
import { AttachmentsSection } from './Attachments'
import { CardHeader } from './CardHeader'
import { TimeSection } from './CardTime'
import { CardActivity } from './CardActivity'
import { CustomFields } from './CustomFields'
import { LinkedFromSection } from './LinkedFrom'
import { Description } from './Description'
import { useCardFiles } from '@/data/cardFiles'
import { Section } from './Section'
import { FieldButton, TaskPicker } from './pickers'

/** The card back: everything about one task, Trello-style. */
export function TaskDialog({
  id,
  onClose,
  editTitle,
  banner,
}: {
  id: string | null
  onClose: () => void
  /** Start in the title: for a card made just now. */ editTitle?: boolean
  /** Shown above the card (the Search cards page says it's view only there, with a way to its board). */
  banner?: ReactNode
}) {
  const { data } = useBoard()
  const archived = !!id && !!data.archived?.[id]
  const open = !!id && (id in data.tasks || archived)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        // (The ✕ is in the card's own top row, with its other buttons: see CardHeader.)
        showCloseButton={false}
        // One column that never grows past the dialog: a long name inside (a parent, say) is cut, not the card widened.
        // On wide screens it's as tall as the window: the header stays put, and under it the card and its comments are
        // two columns that each scroll.
        className="max-h-[calc(100dvh-4rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-3xl lg:max-w-4xl xl:flex xl:h-[calc(100dvh-4rem)] xl:max-w-[1280px] xl:flex-col xl:overflow-hidden"
        // Opening a card is for reading it: nothing in it is put into editing (on a phone, a focused title brings up
        // the keyboard). A card made just now starts in its title, so its name can be typed straight away.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const box = e.currentTarget as HTMLElement
          const title = editTitle ? box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]') : null
          if (title) title.select()
          else box.focus()
        }}
        // Esc while typing leaves the field; a second Esc closes the dialog. (The description and comment editors
        // see to their own Esc, before it gets here: see text/Editor.)
        onEscapeKeyDown={(e) => {
          const el = document.activeElement as HTMLElement | null
          if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) {
            e.preventDefault()
            el.blur()
          }
        }}
      >
        {open && banner}
        {open && (archived ? <ArchivedCard key={id} id={id} onClose={onClose} /> : <TaskDetail key={id} id={id} onClose={onClose} />)}
      </DialogContent>
    </Dialog>
  )
}

/**
 * An archived card: the same card, read-only (with the subtasks archived with it), under a banner that says where it
 * was archived from and whether it was completed, with Restore and Delete.
 */
function ArchivedCard({ id, onClose }: { id: string; onClose: () => void }) {
  const ctx = useBoard()
  const view = useMemo(() => {
    const data = { ...ctx.data, tasks: { ...ctx.data.tasks, ...ctx.data.archived } }
    return { ...ctx, data, idx: indexFor(data), readOnly: true, canComment: false }
  }, [ctx])
  return (
    <>
      <ArchivedBanner id={id} onClose={onClose} />
      <BoardContext.Provider value={view}>
        <TaskDetail id={id} onClose={onClose} />
      </BoardContext.Provider>
    </>
  )
}

/**
 * The card under its header (see CardHeader): what the card is, in a wide column (the board's own fields, its
 * description, subtasks, files, what it waits on, what links to it, the time logged on it), and beside it, on wide
 * screens, its comments. Narrower, the comments come last in the one column.
 */
function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, idx, run, openTask, createTask, readOnly, onActivity, logTime } = useBoard()
  // Wide enough for the comments to have their own column.
  const wide = useMediaQuery('(min-width: 1280px)')
  // The card has scrolled under the header (wide screens, where the header stays put).
  const [scrolled, setScrolled] = useState(false)
  // The card's files, shared by the Files section, comments and the description (# references).
  const cardFiles = useCardFiles(data.board.id, id, onActivity)
  const t = data.tasks[id]
  const kids = idx.childrenOf.get(id) ?? []
  const patch = (fields: TaskFields) => run({ type: 'task.update', id, fields })
  const waitingOn = t.blockedBy.filter((b) => b in data.tasks)

  // A task can't wait on itself (or twice on the same one).
  const notBlocker = useMemo(() => new Set([id, ...t.blockedBy]), [id, t.blockedBy])

  // L: log time on this card (not while typing, or with another box open over it).
  useEffect(() => {
    if (!logTime) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key.toLowerCase() !== 'l' || e.metaKey || e.ctrlKey || e.altKey) return
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || document.querySelectorAll('[role=dialog]').length > 1) return
      e.preventDefault()
      logTime(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logTime, id])

  return (
    <>
      <CardHeader id={id} onClose={onClose} wide={wide} scrolled={scrolled} />

      <div className="grid grid-cols-[minmax(0,1fr)] xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_28rem] xl:grid-rows-[minmax(0,1fr)]">
        {/* The card itself */}
        <div
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
          className="min-w-0 divide-y divide-border/60 px-6 pb-6 xl:min-h-0 xl:overflow-y-auto [&>*]:py-4 [&>*:first-child]:pt-1 [&>*:last-child]:pb-0"
        >
          {/* The board's own fields: what this kind of card is about, so they come first. */}
          <CustomFields task={t} readOnly={readOnly} onChange={(custom) => patch({ custom })} />
          <Description
            key={`desc-${id}`}
            title={t.title}
            value={t.description ?? ''}
            readOnly={readOnly}
            cardFiles={cardFiles}
            people={data.members}
            draftId={`${data.board.id}:${id}`}
            onSave={(description) => patch({ description })}
            full={{
              start: wantsFullPage(id),
              set: (open) => setFullPage(id, open),
              link: `${location.origin}${location.pathname}${hrefFor({ page: 'board', id: data.board.id, task: id, full: true })}`,
            }}
          />

          <Section
            icon={<ListChecks />}
            title="Subtasks"
            count={kids.length}
            aside={kids.length > 0 && <ProgressBar done={idx.subDone.get(id)!} total={idx.subTotal.get(id)!} className="w-40" />}
          >
            {kids.length > 0 && (
              <ul className="mb-1">
                {kids.slice(0, 100).map((k) => {
                  const kc = statusCol(idx, k)
                  const kDerived = data.board.mode === 'derived' && idx.childrenOf.has(k)
                  const isDone = kc.category === 'done'
                  return (
                    <li key={k} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                      <button
                        disabled={kDerived || readOnly}
                        title={readOnly ? undefined : kDerived ? 'Follows its own subtasks' : isDone ? 'Mark as not done' : 'Mark as done'}
                        onClick={() => run({ type: 'task.update', id: k, fields: { status: isDone ? idx.firstOf.todo : idx.firstOf.done } })}
                        className="grid size-5 place-items-center text-muted-foreground hover:text-status-done disabled:opacity-40"
                      >
                        {isDone ? <CheckCircle weight="fill" className="size-5 text-status-done" /> : <Circle className="size-5" />}
                      </button>
                      <button
                        onClick={() => openTask(k)}
                        className={`min-w-0 flex-1 truncate text-left text-sm ${isDone ? 'text-muted-foreground line-through' : ''}`}
                      >
                        {data.tasks[k].title}
                      </button>
                      {idx.childrenOf.has(k) && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {idx.subDone.get(k)}/{idx.subTotal.get(k)}
                        </span>
                      )}
                      <StatusPill col={kc} />
                    </li>
                  )
                })}
                {kids.length > 100 && <li className="px-1 text-xs text-muted-foreground">and {kids.length - 100} more</li>}
              </ul>
            )}
            {!readOnly && (
              <QuickAdd
                label="Add a subtask"
                submitLabel="Add"
                placeholder="Subtask title"
                single
                dates
                onAdd={(title, fields) => createTask(id, { ...fields, title })}
              />
            )}
          </Section>

          <AttachmentsSection cardFiles={cardFiles} cover={t.cover} />

          <Section icon={<Prohibit />} title="Waiting on" count={waitingOn.length}>
            {waitingOn.length > 0 && (
              <ul className="mb-1">
                {waitingOn.map((b) => (
                  <li key={b} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                    <StatusDot category={idx.category.get(b)!} color={statusCol(idx, b).color} />
                    <button onClick={() => openTask(b)} className="min-w-0 flex-1 truncate text-left text-sm">
                      {data.tasks[b].title}
                    </button>
                    <StatusPill col={statusCol(idx, b)} />
                    {!readOnly && (
                      <button
                        aria-label="Stop waiting on this"
                        onClick={() => patch({ blockedBy: t.blockedBy.filter((x) => x !== b) })}
                        className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <TaskPicker
                placeholder="Find a task…"
                exclude={notBlocker}
                onPick={(b) => b && patch({ blockedBy: [...t.blockedBy, b] })}
                trigger={
                  <FieldButton empty className="w-auto">
                    + Add a task this is waiting on
                  </FieldButton>
                }
              />
            )}
          </Section>

          <LinkedFromSection key={id} taskId={id} />

          <TimeSection taskId={id} />

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Created {formatWhen(t.createdAt)}
            {/* (The last real change, as the Outline's Updated column and a list sorted by it have it.) */}
            {changedAt(t) !== t.createdAt && <> · updated {formatWhen(changedAt(t))}</>}
          </p>

          {!wide && (
            <div id="card-comments" className="scroll-mt-4">
              <CardActivity taskId={id} cardFiles={cardFiles} />
            </div>
          )}
        </div>

        {/* Wide screens: the conversation as its own column, the box to write in always in view. */}
        {wide && (
          <div className="flex min-h-0 flex-col border-l px-5 pt-1 pb-4">
            <CardActivity taskId={id} cardFiles={cardFiles} column />
          </div>
        )}
      </div>
    </>
  )
}

/** "Fri 1 May 2026, 10:05" (built-in example tasks have no real time, so they just say "with the example"). */
function formatWhen(iso: string) {
  return iso === EPOCH ? 'with the example board' : formatMoment(iso)
}
