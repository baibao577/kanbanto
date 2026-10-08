import {
  Alarm,
  Archive,
  ArrowElbowDownRight,
  ArrowSquareRight,
  Bell,
  BellRinging,
  CalendarBlank,
  ChatCircle,
  CheckCircle,
  Copy,
  CircleHalf,
  Crosshair,
  DotsThree,
  Flag,
  Tag,
  Timer,
  Trash,
  User,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { COLORS, tone } from '@kanbanto/model/colors'
import type { TaskFields } from '@kanbanto/model/commands'
import { ancestorsOf, descendantsOf, statusCol } from '@kanbanto/model/indexer'
import { refOf } from '@kanbanto/model/refs'
import { formatDuration } from '@kanbanto/model/time'
import { PRIORITIES, PRIORITY_LABEL, type Priority } from '@kanbanto/model/types'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { hrefFor } from '@/app/router'
import { Avatar, ColorSwatches, LabelChip, PriorityIcon, StatusDot, StatusPill } from '@/components/common/bits'
import { TitleDateChip } from '@/components/text/TitleDate'
import { useTitleDate } from '@/components/text/useTitleDate'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDay } from '@/lib/format'
import { copyText } from '@/lib/copy'
import { cn } from '@/lib/utils'
import { dueWords } from './cardDates'
import { LabelPicker } from './LabelPicker'
import { DateField, FieldButton, PersonPicker, TaskPicker } from './pickers'
import { Reminders } from './Reminders'

/**
 * The top of the card window, which stays put while the card scrolls (on wide screens): where the card is, what can
 * be done to it (a new parent, Follow, the rest under ⋯), its title, and a bar with what everyone wants to know about a
 * card at a glance, each tile the button that changes it. Kept low: the card itself is what the window is for.
 */
export function CardHeader({ id, onClose, wide, scrolled }: { id: string; onClose: () => void; wide: boolean; scrolled: boolean }) {
  const { data, idx, run, openTask, focus, readOnly, moveToBoard, counts, canComment } = useBoard()
  const t = data.tasks[id]
  const kids = idx.childrenOf.get(id) ?? []
  const col = statusCol(idx, id)
  const done = col.category === 'done'
  const path = ancestorsOf(data.tasks, id)
  const patch = (fields: TaskFields) => run({ type: 'task.update', id, fields })
  // A task can't move under itself or anything below it.
  const notParent = useMemo(() => new Set([id, ...descendantsOf(idx, id)]), [idx, id])
  const [deleting, setDeleting] = useState(false)
  // Its name (WEB-12): there once the server has given the card its number, a moment after a new one is made.
  const ref = refOf(data.board, t)
  const link = `${location.origin}${location.pathname}${hrefFor({ page: 'board', id: data.board.id, task: id })}`

  return (
    // (No line under it until the card has scrolled under it: then one says where the card goes.)
    <header className={cn('shrink-0 border-b transition-colors', scrolled ? 'border-border' : 'border-transparent')}>
      {/* A low row: small quiet buttons, and the window's ✕ at its end. (A phone: the buttons first, the trail under them.) */}
      <div className="flex flex-wrap items-center gap-x-2 pt-2 pr-3 pl-6">
        {/* One line: short names in full, long ones share what's left and end in … */}
        <nav
          aria-label="Where this card is"
          className="grid min-h-6 min-w-0 auto-cols-[minmax(0,max-content)] grid-flow-col items-center justify-start gap-1 text-xs text-muted-foreground max-sm:order-2 max-sm:basis-full sm:flex-1"
        >
          <span className="truncate" title={data.board.name}>
            {data.board.name}
          </span>
          {path.map((a) => (
            <span key={a} className="flex min-w-0 items-center gap-1">
              <span aria-hidden>/</span>
              <button
                onClick={() => openTask(a)}
                title={data.tasks[a].title}
                className="truncate font-medium text-foreground/80 hover:text-foreground hover:underline"
              >
                {data.tasks[a].title}
              </button>
            </span>
          ))}
          {/* Last, the card's own name: never cut short, and the button that copies the card's link. */}
          {ref && (
            <span className="flex items-center gap-1">
              <span aria-hidden>/</span>
              <button
                type="button"
                onClick={() => void copyText(link, 'Link')}
                title="Copy a link to this card"
                aria-label={`${ref}: copy a link to this card`}
                className="group/ref -mx-0.5 inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] font-medium whitespace-nowrap text-foreground/80 tabular-nums hover:bg-accent hover:text-foreground"
              >
                {ref}
                <Copy className="size-3 opacity-50 group-hover/ref:opacity-100" />
              </button>
            </span>
          )}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Narrower screens: the comments are at the bottom; this goes there. */}
          {!wide && (counts.comments[id] > 0 || canComment) && (
            <button
              type="button"
              onClick={() => document.getElementById('card-comments')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Go to the comments"
            >
              <ChatCircle className="size-3.5" /> {counts.comments[id] || <span className="max-sm:hidden">Comment</span>}
            </button>
          )}
          {/* Which card it's under (the trail says where it is now): another one, or none, which makes it a project. */}
          {!readOnly && (
            <TaskPicker
              placeholder="Move it under…"
              exclude={notParent}
              noneLabel="No parent (make it a project)"
              onPick={(p) => run({ type: 'task.move', id, parentId: p })}
              trigger={
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  title={t.parentId ? 'Put it under another card, or make it a project' : 'Put it under another card'}
                >
                  <ArrowElbowDownRight /> {t.parentId ? 'Change parent' : 'Set parent'}
                </Button>
              }
            />
          )}
          {canComment && <FollowTask boardId={data.board.id} id={id} assigneeId={t.assigneeId} />}
          {(kids.length > 0 || !readOnly) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="More to do with this card">
                  <DotsThree weight="bold" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {kids.length > 0 && (
                  <DropdownMenuItem
                    onSelect={() => {
                      focus(id)
                      onClose()
                    }}
                  >
                    <Crosshair /> Focus on its subtasks
                  </DropdownMenuItem>
                )}
                {!readOnly && (
                  <>
                    <DropdownMenuItem onSelect={() => moveToBoard(id)}>
                      <ArrowSquareRight /> Move to another board…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {!done && (
                      // (Its unfinished subtasks go to the done list with it.)
                      <DropdownMenuItem onSelect={() => run({ type: 'task.archive', id, complete: true }) && onClose()}>
                        <CheckCircle /> Complete and archive
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => run({ type: 'task.archive', id }) && onClose()}>
                      <Archive /> Archive{kids.length > 0 && ` (with ${kids.length} subtask${kids.length === 1 ? '' : 's'})`}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                      <Trash /> Delete task
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <DialogClose asChild>
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Close">
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
      </div>

      <div className="px-6 pb-2">
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

      <CardBar id={id} />
      {!readOnly && <DeleteTask id={id} title={t.title} open={deleting} onOpenChange={setDeleting} onDeleted={onClose} />}
    </header>
  )
}

/** A cell of the bar: a soft tile like the Fields boxes, as tall as two short lines, and a button from edge to edge. */
const CELL =
  'flex min-h-12 w-full min-w-0 flex-col justify-center rounded-lg bg-muted/50 px-3 py-1.5 text-left outline-none transition-colors enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50'

/** What a cell says: the property's name, small, with its picture in the corner, over its value (grey when there is none). */
function CellText({ label, icon, empty, children }: { label: string; icon: ReactNode; empty?: boolean; children: ReactNode }) {
  return (
    <>
      <span className="flex w-full items-center justify-between gap-2 text-[11px] leading-[14px] text-muted-foreground">
        {label}
        <span aria-hidden className="shrink-0 text-muted-foreground/60 [&_svg]:size-3.5">
          {icon}
        </span>
      </span>
      <span className={cn('flex h-[22px] max-w-full min-w-0 items-center gap-1.5 overflow-hidden text-[13px]', empty && 'text-muted-foreground')}>
        {children}
      </span>
    </>
  )
}

/**
 * The bar under the title: Status, Assignee, Priority, Dates, Labels, Time logged. The same cells in the same places
 * on every board (a board's own fields are the card's first section), each saying what it holds or, in grey, that it
 * holds nothing, and each the button that changes it. View only: they say the same and can't be changed, except that
 * Dates still opens, to read the reminders.
 *
 * (Six tiles in a row on a wide screen, three a row below that; on a phone two, with Dates and Labels on rows of
 * their own.)
 */
function CardBar({ id }: { id: string }) {
  const { data, idx, run, readOnly, logTime, counts, access } = useBoard()
  const t = data.tasks[id]
  const col = statusCol(idx, id)
  const derived = data.board.mode === 'derived' && idx.childrenOf.has(id)
  const patch = (fields: TaskFields) => run({ type: 'task.update', id, fields })
  const labelById = useMemo(() => new Map(data.labels.map((l) => [l.id, l])), [data.labels])
  const labels = t.labels.map((l) => labelById.get(l)).filter((l) => !!l)
  const assignee = data.members.find((m) => m.id === t.assigneeId)
  // Logged time isn't shown to visitors with the public link.
  const showTime = access.via !== 'public'
  const own = counts.time[id] ?? 0
  const all = own + descendantsOf(idx, id).reduce((s, k) => s + (counts.time[k] ?? 0), 0)
  const due = t.due && col.category !== 'done' ? dueWords(t.due) : null

  const status = (
    <CellText label="Status" icon={<CircleHalf />}>
      {derived ? <StatusPill col={col} /> : <StatusDot category={col.category} color={col.color} />}
      {derived ? <span className="truncate text-xs text-muted-foreground">from its subtasks</span> : <span className="truncate">{col.name}</span>}
    </CellText>
  )
  const labelsText = (
    <CellText label="Labels" icon={<Tag />} empty={!labels.length}>
      {/* The first three, and how many more: long names give way before a label is left out. */}
      {labels.slice(0, 3).map((l) => (
        <LabelChip key={l.id} label={l} className="max-w-24 min-w-0 shrink overflow-hidden whitespace-nowrap" />
      ))}
      {labels.length > 3 && <span className="shrink-0 text-xs text-muted-foreground">+{labels.length - 3}</span>}
      {!labels.length && 'None'}
    </CellText>
  )
  const timeText = (
    <CellText label="Time logged" icon={<Timer />} empty={!all}>
      <span className="truncate tabular-nums">{own ? formatDuration(own) : all ? 'None on this card' : 'None yet'}</span>
      {all > own && <span className="truncate text-xs text-muted-foreground tabular-nums">· {formatDuration(all)} with subtasks</span>}
    </CellText>
  )

  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-1.5 px-6 pb-3 sm:grid-cols-3',
        // (Labels get the most room after Dates: three of them fit.)
        showTime ? 'xl:grid-cols-[0.8fr_1fr_0.75fr_1.5fr_1.65fr_0.8fr]' : 'xl:grid-cols-[0.8fr_1fr_0.75fr_1.5fr_1.65fr]',
      )}
    >
      {derived || readOnly ? (
        <div className={cn(CELL, 'max-sm:order-1')} title={derived ? 'Follows its subtasks: it changes as they do' : undefined}>
          {status}
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger className={cn(CELL, 'max-sm:order-1')}>{status}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuRadioGroup value={col.id} onValueChange={(v) => patch({ status: v })}>
              {data.columns.map((c) => (
                <DropdownMenuRadioItem key={c.id} value={c.id}>
                  <StatusDot category={c.category} color={c.color} /> {c.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <PersonPicker
        value={t.assigneeId}
        onChange={(assigneeId) => patch({ assigneeId })}
        trigger={
          <button disabled={readOnly} className={cn(CELL, 'max-sm:order-2')}>
            <CellText label="Assignee" icon={<User />} empty={!assignee}>
              {assignee && <Avatar name={assignee.name} picture={assignee.picture} className="size-5 text-[9px]" />}
              <span className="truncate">{assignee?.name ?? 'Nobody'}</span>
            </CellText>
          </button>
        }
      />

      <DropdownMenu>
        <DropdownMenuTrigger disabled={readOnly} className={cn(CELL, 'max-sm:order-3', !showTime && 'max-sm:col-span-2')}>
          <CellText label="Priority" icon={<Flag />} empty={!t.priority}>
            {t.priority && <PriorityIcon priority={t.priority} />}
            <span className="truncate">{t.priority ? PRIORITY_LABEL[t.priority] : 'None'}</span>
          </CellText>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuRadioGroup value={t.priority ?? 'none'} onValueChange={(v) => patch({ priority: v === 'none' ? null : (v as Priority) })}>
            {PRIORITIES.map((p) => (
              <DropdownMenuRadioItem key={p} value={p}>
                <PriorityIcon priority={p} /> {PRIORITY_LABEL[p]}
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuRadioItem value="none" className="text-muted-foreground">
              No priority
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover>
        <PopoverTrigger className={cn(CELL, 'max-sm:order-5 max-sm:col-span-2')}>
          <CellText label="Dates" icon={<CalendarBlank />} empty={!t.start && !t.due}>
            <span className="truncate">
              {t.start && t.due ? (
                <>
                  {formatDay(t.start)} → <span className={cn(due?.late && 'font-medium text-destructive')}>{formatDay(t.due)}</span>
                </>
              ) : t.due ? (
                <>
                  Due <span className={cn(due?.late && 'font-medium text-destructive')}>{formatDay(t.due)}</span>
                </>
              ) : t.start ? (
                `Starts ${formatDay(t.start)}`
              ) : (
                'No dates'
              )}
            </span>
            {due && <span className={cn('truncate text-xs', due.late ? 'text-destructive' : 'text-muted-foreground')}>· {due.text}</span>}
            {!!t.reminders?.length && (
              <span title={t.reminders.length === 1 ? 'A reminder is set' : `${t.reminders.length} reminders are set`} className="flex shrink-0">
                <Alarm className="size-3.5 text-muted-foreground" />
              </span>
            )}
          </CellText>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          {/* View only: every date shows but can't be changed. */}
          <fieldset disabled={readOnly} className="min-w-0 space-y-1">
            <SideField label="Start">
              <DateField icon={false} value={t.start} placeholder="Add a start date" onChange={(start) => patch({ start: start ?? '' })} />
            </SideField>
            <SideField label="Due">
              <DateField icon={false} value={t.due} placeholder="Add a due date" defaultTime="17:00" onChange={(d) => patch({ due: d ?? '' })} />
            </SideField>
            <SideField label="Reminders">
              <Reminders task={t} readOnly={readOnly} onChange={(reminders) => patch({ reminders })} />
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
          </fieldset>
        </PopoverContent>
      </Popover>

      {readOnly ? (
        <div
          className={cn(CELL, 'max-sm:order-6 max-sm:col-span-2', !showTime && 'sm:max-xl:col-span-2')}
          title={labels.map((l) => l.name).join(', ') || undefined}
        >
          {labelsText}
        </div>
      ) : (
        <LabelPicker
          selected={t.labels}
          onChange={(next) => patch({ labels: next })}
          trigger={<button className={cn(CELL, 'max-sm:order-6 max-sm:col-span-2', !showTime && 'sm:max-xl:col-span-2')}>{labelsText}</button>}
        />
      )}

      {showTime &&
        (logTime ? (
          <button type="button" onClick={() => logTime(id)} title="Log time on this card (L)" className={cn(CELL, 'max-sm:order-4')}>
            {timeText}
          </button>
        ) : (
          <div className={cn(CELL, 'max-sm:order-4')}>{timeText}</div>
        ))}
    </div>
  )
}

/** A line in the Dates box: its name and its value side by side (the value may take more lines, like reminders). */
function SideField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start">
      <p className="truncate pl-2 text-[13px] leading-8 font-medium text-foreground" title={label}>
        {label}
      </p>
      <div className="min-w-0">{children}</div>
    </div>
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
        className="-mx-2 block w-[calc(100%+1rem)] resize-none rounded-md px-2 py-0.5 text-xl font-semibold outline-none [field-sizing:content] hover:bg-accent/60 focus:bg-background focus:ring-2 focus:ring-ring/40"
      />
      {fresh && <TitleDateChip state={date} className="mt-1" />}
    </div>
  )
}

/**
 * Whether you follow this card, and the button to start or stop. Followers are told (bell, morning email, desktop
 * notifications) about its comments and what happens to it; people follow the cards they're part of without asking.
 */
function FollowTask({ boardId, id, assigneeId }: { boardId: string; id: string; assigneeId?: string }) {
  const [following, setFollowing] = useState<boolean | null>(null)
  // (Asked again when it's assigned: that can start it. Commenting does too, so the comments say when they change.)
  const { onActivity } = useBoard()
  useEffect(() => {
    const load = () =>
      api<{ following: boolean }>('GET', `/boards/${boardId}/tasks/${id}/follow`).then(
        (r) => setFollowing(r.following),
        () => {},
      )
    void load()
    return onActivity((m) => {
      if (m.type === 'comment' && m.taskId === id && m.action === 'added') void load()
    })
  }, [boardId, id, assigneeId, onActivity])
  if (following === null) return null
  const set = (next: boolean) => {
    setFollowing(next)
    api<{ following: boolean }>('PUT', `/boards/${boardId}/tasks/${id}/follow`, { following: next }).then(
      (r) => setFollowing(r.following),
      (e) => {
        setFollowing(!next)
        toast.error(errorMessage(e))
      },
    )
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      aria-pressed={following}
      title={
        following
          ? 'You’re told about comments and changes on this card. Click to stop.'
          : 'Be told about comments and changes on this card (bell, morning email, desktop notifications)'
      }
      onClick={() => set(!following)}
    >
      {following ? <BellRinging weight="fill" /> : <Bell />}
      <span className="max-sm:sr-only">{following ? 'Following' : 'Follow'}</span>
    </Button>
  )
}

/** Asking before a task is deleted (with its subtasks): opened from the ⋯ menu. */
function DeleteTask({
  id,
  title,
  open,
  onOpenChange,
  onDeleted,
}: {
  id: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const { idx, run } = useBoard()
  const n = descendantsOf(idx, id).length
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
