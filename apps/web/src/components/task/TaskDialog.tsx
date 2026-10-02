import { Archive, ArrowSquareRight, CaretRight, CheckCircle, Circle, Crosshair, ListChecks, Plus, Prohibit, Trash, X } from '@phosphor-icons/react'
import { formatMoment } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BoardContext, useBoard } from '@/app/board-context'
import { ColorSwatches, LabelChip, PriorityIcon, ProgressBar, StatusDot, StatusPill } from '@/components/common/bits'
import { QuickAdd } from '@/components/board/QuickAdd'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ancestorsOf, descendantsOf, indexFor, statusCol } from '@kanbanto/model/indexer'
import { COLORS, tone } from '@kanbanto/model/colors'
import type { TaskFields } from '@kanbanto/model/commands'
import { EPOCH, PRIORITIES, PRIORITY_LABEL, type Priority } from '@kanbanto/model/types'
import { ArchivedBanner } from './ArchivedTask'
import { AttachmentsSection } from './Attachments'
import { CommentsSection } from './Comments'
import { Description } from './Description'
import { useCardFiles } from '@/data/cardFiles'
import { LabelPicker } from './LabelPicker'
import { Reminders } from './Reminders'
import { TitleDateChip } from '@/components/text/TitleDate'
import { useTitleDate } from '@/components/text/useTitleDate'
import { Section } from './Section'
import { DateField, FieldButton, PersonPicker, TaskPicker } from './pickers'

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
        className="max-h-[calc(100dvh-4rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
        // Opening a card is for reading it: nothing in it is put into editing (on a phone, a focused title brings up
        // the keyboard). A card made just now starts in its title, so its name can be typed straight away.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const box = e.currentTarget as HTMLElement
          const title = editTitle ? box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]') : null
          if (title) title.select()
          else box.focus()
        }}
        // Esc while typing leaves the field; a second Esc closes the dialog.
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

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, idx, run, openTask, createTask, focus, readOnly, onActivity, moveToBoard } = useBoard()
  // The card's files, shared by the Files section, comments and the description (# references).
  const cardFiles = useCardFiles(data.board.id, id, onActivity)
  const t = data.tasks[id]
  const kids = idx.childrenOf.get(id) ?? []
  const col = statusCol(idx, id)
  const derived = data.board.mode === 'derived' && kids.length > 0
  const path = ancestorsOf(data.tasks, id)
  const labelById = useMemo(() => new Map(data.labels.map((l) => [l.id, l])), [data.labels])
  const patch = (fields: TaskFields) => run({ type: 'task.update', id, fields })

  // A task can't move under itself or anything below it, and can't wait on itself.
  const notParent = useMemo(() => new Set([id, ...descendantsOf(idx, id)]), [idx, id])
  const notBlocker = useMemo(() => new Set([id, ...t.blockedBy]), [id, t.blockedBy])

  return (
    <>
      <div className="px-6 pt-5 pr-12">
        <nav className="mb-1 flex min-h-5 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {path.length === 0 ? (
            <span>Project</span>
          ) : (
            path.map((a, i) => (
              <span key={a} className="flex max-w-full min-w-0 items-center gap-1">
                {i > 0 && <CaretRight className="size-3 shrink-0" />}
                <button onClick={() => openTask(a)} title={data.tasks[a].title} className="truncate hover:text-foreground hover:underline">
                  {data.tasks[a].title}
                </button>
              </span>
            ))
          )}
        </nav>
        <DialogTitle className="sr-only">{t.title}</DialogTitle>
        <DialogDescription className="sr-only">Task details</DialogDescription>
        <TitleField
          key={`title-${id}`}
          title={t.title}
          readOnly={readOnly}
          // A reminder from the title is added to the card's others.
          onSave={(title, fields) =>
            patch({ ...fields, title, ...(fields.reminders && { reminders: [...(t.reminders ?? []), ...fields.reminders] }) })
          }
        />
      </div>

      <div className="grid items-start gap-6 px-6 pt-4 pb-6 md:grid-cols-[1fr_14rem] md:gap-0">
        {/* Main column */}
        <div className="min-w-0 divide-y md:pr-6 [&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          <Description
            key={`desc-${id}`}
            title={t.title}
            value={t.description ?? ''}
            readOnly={readOnly}
            cardFiles={cardFiles}
            onSave={(description) => patch({ description })}
          />

          <AttachmentsSection cardFiles={cardFiles} />

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

          <Section icon={<Prohibit />} title="Waiting on" count={t.blockedBy.filter((b) => b in data.tasks).length}>
            {t.blockedBy.filter((b) => b in data.tasks).length > 0 && (
              <ul className="mb-1">
                {t.blockedBy
                  .filter((b) => b in data.tasks)
                  .map((b) => (
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

          <CommentsSection taskId={id} cardFiles={cardFiles} />
        </div>

        {/* Side column */}
        <aside className="border-t pt-5 md:sticky md:top-4 md:border-t-0 md:border-l md:pt-0 md:pl-6">
          {/* View only: every field shows its value but can't be changed. */}
          <fieldset disabled={readOnly} className="min-w-0 divide-y [&>*]:space-y-4 [&>*]:py-4 [&>*:first-child]:pt-0">
            <div>
              <SideField label="Status">
                {derived ? (
                  <div className="flex h-8 items-center gap-2 px-2 text-sm">
                    <StatusPill col={col} />
                    <span className="text-xs text-muted-foreground">follows its subtasks</span>
                  </div>
                ) : (
                  <Select value={col.id} onValueChange={(v) => patch({ status: v })}>
                    <SelectTrigger size="sm" className="w-full border-transparent shadow-none hover:bg-accent">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.columns.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <StatusDot category={c.category} color={c.color} /> {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SideField>

              <SideField label="Parent">
                <TaskPicker
                  placeholder="Move it under…"
                  exclude={notParent}
                  noneLabel="No parent (make it a project)"
                  onPick={(p) => run({ type: 'task.move', id, parentId: p })}
                  trigger={<FieldButton empty={!t.parentId}>{t.parentId ? data.tasks[t.parentId]?.title : 'None — it’s a project'}</FieldButton>}
                />
              </SideField>

              <SideField label="Assignee">
                <PersonPicker value={t.assigneeId} onChange={(assigneeId) => patch({ assigneeId })} />
              </SideField>

              <SideField label="Priority">
                <Select value={t.priority ?? 'none'} onValueChange={(v) => patch({ priority: v === 'none' ? null : (v as Priority) })}>
                  <SelectTrigger
                    size="sm"
                    aria-label="Priority"
                    className={cn('w-full border-transparent shadow-none hover:bg-accent', !t.priority && 'text-muted-foreground')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        <PriorityIcon priority={p} /> {PRIORITY_LABEL[p]}
                      </SelectItem>
                    ))}
                    <SelectItem value="none" className="text-muted-foreground">
                      No priority
                    </SelectItem>
                  </SelectContent>
                </Select>
              </SideField>
            </div>
            <div>
              <SideField label="Start">
                <DateField value={t.start} placeholder="Add a start date" onChange={(start) => patch({ start: start ?? '' })} />
              </SideField>
              <SideField label="Due">
                <DateField value={t.due} placeholder="Add a due date" defaultTime="17:00" onChange={(due) => patch({ due: due ?? '' })} />
              </SideField>
              <SideField label="Reminders">
                <Reminders task={t} readOnly={readOnly} onChange={(reminders) => patch({ reminders })} />
              </SideField>
            </div>
            <div>
              <SideField label="Labels">
                <div className="flex flex-wrap items-center gap-1 px-1">
                  {t.labels
                    .map((l) => labelById.get(l))
                    .filter((l) => !!l)
                    .map((l) => (
                      <LabelPicker
                        key={l.id}
                        selected={t.labels}
                        onChange={(labels) => patch({ labels })}
                        trigger={
                          <button className="rounded transition-[filter] hover:brightness-95">
                            <LabelChip label={l} className="h-7 px-2 text-xs" />
                          </button>
                        }
                      />
                    ))}
                  <LabelPicker
                    selected={t.labels}
                    onChange={(labels) => patch({ labels })}
                    trigger={
                      <button
                        aria-label="Add a label"
                        className={
                          t.labels.length
                            ? 'grid size-7 place-items-center rounded bg-secondary text-muted-foreground hover:text-foreground'
                            : 'flex h-7 items-center gap-1.5 rounded px-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground'
                        }
                      >
                        <Plus className="size-3.5" />
                        {!t.labels.length && 'Add a label'}
                      </button>
                    }
                  />
                </div>
              </SideField>

              <SideField label="Timeline color">
                <Popover>
                  <PopoverTrigger asChild>
                    <FieldButton empty={!t.color}>
                      <span
                        className="size-4 shrink-0 rounded"
                        style={t.color ? { backgroundColor: tone(t.color) } : { boxShadow: 'inset 0 0 0 1.5px var(--border)' }}
                      />
                      {t.color ? COLORS.find((c) => c.id === t.color)?.name : 'Same as its status'}
                    </FieldButton>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64">
                    <ColorSwatches value={t.color} noneLabel="Same as its status" onChange={(color) => patch({ color: color ?? null })} />
                  </PopoverContent>
                </Popover>
              </SideField>
            </div>
          </fieldset>

          <div className="space-y-1 border-t pt-4">
            {kids.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => {
                  focus(id)
                  onClose()
                }}
              >
                <Crosshair /> Focus on its subtasks
              </Button>
            )}
            {!readOnly && (
              <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={() => moveToBoard(id)}>
                <ArrowSquareRight /> Move to another board…
              </Button>
            )}
            {!readOnly && col.category !== 'done' && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                title="Moves it (and its unfinished subtasks) to the done list, then archives it"
                onClick={() => {
                  if (run({ type: 'task.archive', id, complete: true })) onClose()
                }}
              >
                <CheckCircle /> Complete and archive
              </Button>
            )}
            {!readOnly && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => {
                  if (run({ type: 'task.archive', id })) onClose()
                }}
              >
                <Archive /> Archive{kids.length > 0 && ` (with ${kids.length} subtask${kids.length === 1 ? '' : 's'})`}
              </Button>
            )}
            {!readOnly && <DeleteTask id={id} title={t.title} onDeleted={onClose} />}
          </div>
          <p className="mt-3 px-2 text-[11px] leading-relaxed text-muted-foreground">
            Created {formatWhen(t.createdAt)}
            {t.version > 1 && <> · updated {formatWhen(t.updatedAt)}</>}
          </p>
        </aside>
      </div>
    </>
  )
}

/**
 * The task's title, edited in place. Only a change you made is saved: if someone renames the task while it's open,
 * their title shows here (unless you're typing), and clicking in and out again doesn't put the old one back.
 */
function TitleField({ title, readOnly, onSave }: { title: string; readOnly: boolean; onSave: (title: string, fields: TaskFields) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // The title as it was when editing started (so only newly typed date words count).
  const [atFocus, setAtFocus] = useState(title)
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.value = title
  }, [title])
  // A time typed into the title while editing (not one that was already there) can become the due date.
  const date = useTitleDate(draft ?? '')
  const fresh = !!date.when && !atFocus.toLowerCase().includes(date.when.text.toLowerCase())
  return (
    <div>
      <textarea
        ref={ref}
        defaultValue={title}
        rows={1}
        aria-label="Title"
        readOnly={readOnly}
        onFocus={(e) => {
          setAtFocus(e.target.value)
          setDraft(e.target.value)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
        onBlur={(e) => {
          const v = e.target.value.trim()
          const { title: next, fields } = fresh ? date.apply(v) : { title: v, fields: {} }
          if (next && (next !== atFocus.trim() || Object.keys(fields).length)) {
            onSave(next, fields)
            e.target.value = next
          } else e.target.value = title
          setDraft(null)
          date.reset()
        }}
        className="-mx-2 w-[calc(100%+1rem)] resize-none rounded-md px-2 py-1 text-xl font-semibold outline-none [field-sizing:content] hover:bg-accent/60 focus:bg-background focus:ring-2 focus:ring-ring/40"
      />
      {fresh && <TitleDateChip state={date} className="mt-1" />}
    </div>
  )
}

function SideField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 px-2 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

function DeleteTask({ id, title, onDeleted }: { id: string; title: string; onDeleted: () => void }) {
  const { idx, run } = useBoard()
  const n = descendantsOf(idx, id).length
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-destructive hover:text-destructive">
          <Trash /> Delete task
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {n ? `Its ${n} ${n === 1 ? 'subtask' : 'subtasks'} will be deleted too. ` : ''}This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => {
              run({ type: 'task.delete', id })
              onDeleted()
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** "Fri 1 May 2026, 10:05" (built-in example tasks have no real time, so they just say "with the example"). */
function formatWhen(iso: string) {
  return iso === EPOCH ? 'with the example board' : formatMoment(iso)
}
