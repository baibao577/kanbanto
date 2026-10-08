import type { BoardField } from '@kanbanto/model/fields'
import { FieldChip } from '@/components/fields/FieldValue'
import {
  Alarm,
  Archive,
  ArrowDown,
  ArrowLineDown,
  ArrowLineUp,
  ArrowSquareOut,
  ArrowSquareRight,
  ArrowsLeftRight,
  ChatCircle,
  CheckCircle,
  Crosshair,
  DotsThree,
  ListChecks,
  Paperclip,
  Prohibit,
  Timer,
} from '@phosphor-icons/react'
import { memo } from 'react'
import { AgeChip, Avatar, DueChip, LabelChip, PriorityChip, ProgressBar, StatusDot, StatusPill } from '@/components/common/bits'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatDuration } from '@kanbanto/model/time'
import { formatDay } from '@/lib/format'
import { AGE_SHOWN, idleDays, lastActivity } from '@kanbanto/model/age'
import { upcoming } from '@kanbanto/model/reminders'
import { ancestorsOf, isBlocked, statusCol, type TaskIndex } from '@kanbanto/model/indexer'
import type { LabelDef, ViewConfig } from '@kanbanto/model/types'
import type { Lane } from '@kanbanto/model/view'

const CHECKLIST_MAX = 5
const NO_FIELDS: BoardField[] = []

interface Props {
  id: string
  idx: TaskIndex
  config: ViewConfig
  /** The board's letters: with Display → Card numbers on, a card shows its name (WEB-12) above its title. */
  code?: string
  labelById: Map<string, LabelDef>
  /** The board's fields that show on card fronts (up to three): a card shows the ones it has a value for. */
  frontFields?: BoardField[]
  onOpen: (id: string) => void
  onFocus: (id: string) => void
  /** Set when this task also has its own row on the board. */
  onJumpToRow?: (id: string) => void
  /** Moving without dragging, from the card's menu: the board's columns, the card's column, and what to do. */
  move?: {
    lists: Lane[]
    col: string
    to: (id: string, where: { col: string } | 'top' | 'bottom') => void
    toBoard: (id: string) => void
    archive: (id: string, complete?: boolean) => void
    /** A card of the Inbox panel: the board that's open beside it, to move the card there. */
    here?: { name: string; go: (id: string) => void }
  }
  /** In a grouped list: the card has no parent header, so it's one of the list's items (see dnd.ts). */
  item?: boolean
  /** View only: the card can't be dragged. */
  readOnly?: boolean
  /** Draw its cover, when it has one (the Board does, unless covers are switched off in Display). */
  covers?: boolean
  /** How many comments and files it has, and when the latest comment was written (card age). */
  comments?: number
  files?: number
  lastComment?: string
  /** Minutes logged on it (with its subtasks'). */
  time?: number
  /** Opens the log box on this card (when you can log time). */
  onLogTime?: (id: string) => void
}

export const TaskCard = memo(function TaskCard({
  id,
  idx,
  config,
  code,
  labelById,
  frontFields = NO_FIELDS,
  onOpen,
  onFocus,
  onJumpToRow,
  move,
  item,
  readOnly,
  covers,
  comments = 0,
  files = 0,
  lastComment,
  time = 0,
  onLogTime,
}: Props) {
  const t = idx.tasks[id]
  const kids = idx.childrenOf.get(id)
  const d = config.parentDisplay
  const done = idx.subDone.get(id)!
  const total = idx.subTotal.get(id)!
  const col = statusCol(idx, id)
  const blocked = isBlocked(idx, id)
  // The next reminder still to go off (shown as a small alarm).
  const next = t.reminders ? upcoming(t)[0] : undefined
  const path = d.includes('label') && t.parentId ? ancestorsOf(idx.tasks, id).map((a) => idx.tasks[a].title) : null
  // (A card just made has no number until the server answers: nothing is shown for that moment.)
  const ref = config.cardNumbers && code && t.number ? `${code}-${t.number}` : null
  const labels = t.labels.map((l) => labelById.get(l)).filter((l) => !!l)
  // Card age (Display → Card age): days without activity, once it's been a few, and never on finished cards.
  const activeAt = lastActivity(idx, id, lastComment ? { [id]: lastComment } : undefined)
  const idle = idleDays(activeAt)
  const age = d.includes('age') && col.category !== 'done' && idle >= AGE_SHOWN ? idle : null
  const fields = frontFields.filter((f) => t.custom?.[f.id] !== undefined)
  const chips = config.columns === 'parent' || !!t.priority || blocked || !!t.due || age !== null || fields.length > 0
  const meta = !!next || (!!kids && !d.includes('progress')) || comments > 0 || files > 0 || time > 0
  const who = t.assigneeId ? idx.members.get(t.assigneeId) : undefined
  const assignee = t.assigneeId && <Avatar name={who?.name ?? '?'} picture={who?.picture} className="ml-auto size-5 text-[9px]" />

  return (
    <article
      data-card-id={id}
      data-item={item ? '' : undefined}
      data-drag={readOnly ? undefined : 'card'}
      tabIndex={0}
      aria-label={t.title}
      onClick={() => onOpen(id)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(id)}
      className="group/card drag-handle relative cursor-pointer rounded-lg border border-(--card-edge) bg-(--tile) px-3 py-2.5 text-card-foreground shadow-tile transition-[border-color,box-shadow,opacity] outline-none hover:border-foreground/20 hover:shadow-tile-hover focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {/* Its cover: one of its pictures, across the top (the file's small copy: see the server's routes/covers.ts).
          The frame has its height before the picture arrives, so nothing under it jumps; the picture fills it, cut
          from the middle. Not something to drag by itself: the browser dragging a picture would end the card's drag. */}
      {covers && t.cover && (
        <div className="-mx-3 -mt-2.5 mb-2 aspect-video overflow-hidden rounded-t-[7px] border-b border-(--card-edge) bg-muted">
          <img
            src={`/api/attachments/${t.cover}/thumb`}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            // (A cover that can't be had, its file gone meanwhile, leaves the card without one.)
            onError={(e) => (e.currentTarget.parentElement!.hidden = true)}
            className="size-full bg-white object-cover select-none"
          />
        </div>
      )}

      {labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 pr-12">
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}

      {/* Its name and where it belongs share a line, apart from the title (which is found by its exact words). */}
      {(ref || path) && (
        <p className={cn('mb-0.5 truncate text-[11px] leading-4 text-muted-foreground', !labels.length && 'pr-12')}>
          {ref && <span className="font-mono font-medium tabular-nums">{ref}</span>}
          {ref && path && <span aria-hidden> · </span>}
          {path?.join(' › ')}
        </p>
      )}

      {/* On touch screens the menu button always shows, so keep the first line clear of it. */}
      <p className={cn('text-sm leading-snug break-words', kids && 'font-medium', !labels.length && !path && !ref && 'touch-only:pr-6')}>{t.title}</p>

      {d.includes('checklist') && kids && (
        <ul className="mt-2 space-y-1">
          {kids.slice(0, CHECKLIST_MAX).map((k) => {
            const kc = statusCol(idx, k)
            return (
              <li key={k} className={cn('flex items-center gap-2 text-xs', kc.category === 'done' && 'text-muted-foreground line-through')}>
                <StatusDot category={kc.category} color={kc.color} />
                <span className="truncate">{idx.tasks[k].title}</span>
              </li>
            )
          })}
          {kids.length > CHECKLIST_MAX && <li className="pl-4 text-xs text-muted-foreground">and {kids.length - CHECKLIST_MAX} more</li>}
        </ul>
      )}

      {d.includes('progress') && kids && <ProgressBar done={done} total={total} className="mt-2.5" />}

      {(chips || meta || t.assigneeId) && (
        <footer className="mt-2 space-y-1.5">
          {/* What needs attention first (chips), then the quiet counts, with the assignee on the right. */}
          {chips && (
            <div className="flex flex-wrap items-center gap-1.5">
              {config.columns === 'parent' && <StatusPill col={col} />}
              {t.priority && <PriorityChip priority={t.priority} />}
              {blocked && (
                <span className="inline-flex h-5 items-center gap-1 rounded bg-warning/12 px-1.5 text-[11px] font-medium text-warning">
                  <Prohibit weight="bold" className="size-3" /> Waiting
                </span>
              )}
              {t.due && <DueChip due={t.due} done={col.category === 'done'} />}
              {age !== null && <AgeChip days={age} since={activeAt} />}
              {fields.map((f) => (
                <FieldChip key={f.id} field={f} value={t.custom![f.id]} />
              ))}
              {!meta && assignee}
            </div>
          )}
          {(meta || (!chips && t.assigneeId)) && (
            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground tabular-nums">
              {next && (
                <span className="inline-flex h-5 items-center" title={`Reminder: ${formatDay(next.at.toISOString(), true)}`}>
                  <Alarm className="size-3.5" />
                </span>
              )}
              {kids && !d.includes('progress') && (
                <span className="inline-flex h-5 items-center gap-1" title={`${done} of ${total} subtasks done`}>
                  <ListChecks className="size-3.5" /> {done}/{total}
                </span>
              )}
              {comments > 0 && (
                <span className="inline-flex h-5 items-center gap-1" title={`${comments} comment${comments === 1 ? '' : 's'}`}>
                  <ChatCircle className="size-3.5" /> {comments}
                </span>
              )}
              {files > 0 && (
                <span className="inline-flex h-5 items-center gap-1" title={`${files} file${files === 1 ? '' : 's'}`}>
                  <Paperclip className="size-3.5" /> {files}
                </span>
              )}
              {time > 0 && (
                <span className="inline-flex h-5 items-center gap-1" title={`${formatDuration(time)} logged${kids ? ', with its subtasks' : ''}`}>
                  <Timer className="size-3.5" /> {formatDuration(time)}
                </span>
              )}
              {assignee}
            </div>
          )}
        </footer>
      )}

      {/* Hover actions. Touch screens can't hover: they get the menu only, which has these too. */}
      <div className="absolute top-1.5 right-1.5 flex gap-0.5">
        {onJumpToRow && (
          <CardAction label="Go to its row" onClick={() => onJumpToRow(id)} className="touch-only:hidden">
            <ArrowDown className="size-3.5" />
          </CardAction>
        )}
        {kids && (
          <CardAction label="Focus on its subtasks" onClick={() => onFocus(id)} className="touch-only:hidden">
            <Crosshair className="size-3.5" />
          </CardAction>
        )}
        <CardMenu
          id={id}
          idx={idx}
          title={t.title}
          onOpen={onOpen}
          onFocus={kids ? onFocus : undefined}
          onJumpToRow={onJumpToRow}
          move={readOnly ? undefined : move}
          onLogTime={onLogTime}
        />
      </div>
    </article>
  )
})

const ACTION =
  'grid size-6 place-items-center rounded-md border border-border/70 bg-(--tile) text-muted-foreground opacity-0 shadow-xs transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 hover:text-foreground'

function CardAction({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          className={cn(ACTION, className)}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The card's own menu: open it, and move it without dragging (the only way on some devices). */
function CardMenu({
  id,
  idx,
  title,
  onOpen,
  onFocus,
  onJumpToRow,
  move,
  onLogTime,
}: {
  id: string
  idx: TaskIndex
  title: string
  onOpen: (id: string) => void
  onFocus?: (id: string) => void
  onJumpToRow?: (id: string) => void
  move?: Props['move']
  onLogTime?: (id: string) => void
}) {
  const others = move?.lists.filter((l) => l.key !== move.col) ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`${title} options`}
          onClick={(e) => e.stopPropagation()}
          className={cn(ACTION, 'touch-only:opacity-100 data-[state=open]:opacity-100')}
        >
          <DotsThree weight="bold" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      {/* Menu clicks would otherwise reach the card (React passes events up through portals) and open it. */}
      <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onOpen(id)}>
          <ArrowSquareOut /> Open
        </DropdownMenuItem>
        {onFocus && (
          <DropdownMenuItem onSelect={() => onFocus(id)}>
            <Crosshair /> Focus on its subtasks
          </DropdownMenuItem>
        )}
        {onJumpToRow && (
          <DropdownMenuItem onSelect={() => onJumpToRow(id)}>
            <ArrowDown /> Go to its row
          </DropdownMenuItem>
        )}
        {onLogTime && (
          <DropdownMenuItem onSelect={() => onLogTime(id)}>
            <Timer /> Log time…
          </DropdownMenuItem>
        )}
        {move && (
          <>
            <DropdownMenuSeparator />
            {others.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowsLeftRight /> Move to
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                  {others.map((l) => {
                    const c = idx.colById.get(l.key)
                    return (
                      <DropdownMenuItem key={l.key} onSelect={() => move.to(id, { col: l.key })}>
                        {c && <StatusDot category={c.category} color={c.color} />}
                        <span className="truncate">{l.title}</span>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem onSelect={() => move.to(id, 'top')}>
              <ArrowLineUp /> Move to top
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => move.to(id, 'bottom')}>
              <ArrowLineDown /> Move to bottom
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {move.here && (
              <DropdownMenuItem onSelect={() => move.here!.go(id)}>
                <ArrowSquareRight /> <span className="truncate">Move to “{move.here.name}”…</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => move.toBoard(id)}>
              <ArrowSquareRight /> Move to another board…
            </DropdownMenuItem>
            {statusCol(idx, id).category !== 'done' && (
              <DropdownMenuItem onSelect={() => move.archive(id, true)}>
                <CheckCircle /> Complete and archive
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => move.archive(id)}>
              <Archive /> Archive
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
