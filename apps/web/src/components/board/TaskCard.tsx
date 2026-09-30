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
  Crosshair,
  DotsThree,
  ListChecks,
  Paperclip,
  Prohibit,
} from '@phosphor-icons/react'
import { memo } from 'react'
import { Avatar, DueChip, LabelChip, PriorityChip, ProgressBar, StatusDot, StatusPill } from '@/components/common/bits'
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
import { formatDay } from '@/lib/format'
import { upcoming } from '@kanbanto/model/reminders'
import { ancestorsOf, isBlocked, statusCol, type TaskIndex } from '@kanbanto/model/indexer'
import type { LabelDef, ViewConfig } from '@kanbanto/model/types'
import type { Lane } from '@kanbanto/model/view'

const CHECKLIST_MAX = 5

interface Props {
  id: string
  idx: TaskIndex
  config: ViewConfig
  labelById: Map<string, LabelDef>
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
    archive: (id: string) => void
  }
  /** In a grouped list: the card has no parent header, so it's one of the list's items (see dnd.ts). */
  item?: boolean
  /** View only: the card can't be dragged. */
  readOnly?: boolean
  /** How many comments and files it has. */
  comments?: number
  files?: number
}

export const TaskCard = memo(function TaskCard({
  id,
  idx,
  config,
  labelById,
  onOpen,
  onFocus,
  onJumpToRow,
  move,
  item,
  readOnly,
  comments = 0,
  files = 0,
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
  const labels = t.labels.map((l) => labelById.get(l)).filter((l) => !!l)

  return (
    <article
      data-card-id={id}
      data-item={item ? '' : undefined}
      data-drag={readOnly ? undefined : 'card'}
      tabIndex={0}
      aria-label={t.title}
      onClick={() => onOpen(id)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(id)}
      className="group/card drag-handle relative cursor-pointer rounded-lg border border-(--card-edge) bg-(--tile) px-3 py-2.5 text-card-foreground shadow-xs transition-[border-color,box-shadow,opacity] outline-none hover:border-foreground/20 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 pr-12">
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}

      {path && <p className={cn('mb-0.5 truncate text-[11px] leading-4 text-muted-foreground', !labels.length && 'pr-12')}>{path.join(' › ')}</p>}

      {/* On touch screens the menu button always shows, so keep the first line clear of it. */}
      <p className={cn('text-sm leading-snug break-words', kids && 'font-medium', !labels.length && !path && 'touch-only:pr-6')}>{t.title}</p>

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

      {(config.columns === 'parent' ||
        t.priority ||
        next ||
        blocked ||
        t.due ||
        (kids && !d.includes('progress')) ||
        t.assigneeId ||
        comments > 0 ||
        files > 0) && (
        <footer className="mt-2 flex flex-wrap items-center gap-1.5">
          {config.columns === 'parent' && <StatusPill col={col} />}
          {t.priority && <PriorityChip priority={t.priority} />}
          {blocked && (
            <span className="inline-flex h-5 items-center gap-1 rounded bg-warning/12 px-1.5 text-[11px] font-medium text-warning">
              <Prohibit weight="bold" className="size-3" /> Waiting
            </span>
          )}
          {t.due && <DueChip due={t.due} done={col.category === 'done'} />}
          {next && (
            <span className="inline-flex h-5 items-center text-muted-foreground" title={`Reminder: ${formatDay(next.at.toISOString(), true)}`}>
              <Alarm className="size-3.5" />
            </span>
          )}
          {kids && !d.includes('progress') && (
            <span className="inline-flex h-5 items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
              <ListChecks className="size-3.5" /> {done}/{total}
            </span>
          )}
          {comments > 0 && (
            <span
              className="inline-flex h-5 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
              title={`${comments} comment${comments === 1 ? '' : 's'}`}
            >
              <ChatCircle className="size-3.5" /> {comments}
            </span>
          )}
          {files > 0 && (
            <span
              className="inline-flex h-5 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
              title={`${files} file${files === 1 ? '' : 's'}`}
            >
              <Paperclip className="size-3.5" /> {files}
            </span>
          )}
          {t.assigneeId && <Avatar name={idx.members.get(t.assigneeId)?.name ?? '?'} className="ml-auto size-5 text-[9px]" />}
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
}: {
  id: string
  idx: TaskIndex
  title: string
  onOpen: (id: string) => void
  onFocus?: (id: string) => void
  onJumpToRow?: (id: string) => void
  move?: Props['move']
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
            <DropdownMenuItem onSelect={() => move.toBoard(id)}>
              <ArrowSquareRight /> Move to another board…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => move.archive(id)}>
              <Archive /> Archive
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
