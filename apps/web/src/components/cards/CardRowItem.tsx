import { Archive, ArrowCounterClockwise, ChatCircle, CheckCircle, ListChecks, Trash } from '@phosphor-icons/react'
import type { CardRow } from '@kanbanto/model/api'
import { Avatar, BoardDot, DueChip, LabelChip, PriorityChip, StatusPill } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { formatMoment } from '@/lib/format'
import { momentWords } from './search'

/**
 * One card in the search results: where it lives (board › parents), its title, and what a card on a board shows
 * (list, labels, priority, due, who), plus the date the search is about. Opening it shows the card, view only. An
 * archived one can be restored or deleted from here (by editors).
 */
export function CardRowItem({
  card,
  showBoard,
  now,
  onOpen,
  onRestore,
  onDelete,
}: {
  card: CardRow
  showBoard: boolean
  now: number
  onOpen: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const c = card
  const where = [...(showBoard ? [c.board.name] : []), ...c.path]
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <button type="button" onClick={onOpen} className="group min-w-0 flex-1 text-left">
        {where.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {showBoard && <BoardDot background={c.board.background} />}
            <span className="truncate">{where.join(' › ')}</span>
          </span>
        )}
        <span className="flex min-w-0 items-center gap-2">
          <span className={`truncate text-sm font-medium group-hover:underline ${c.done && !c.archived ? 'text-muted-foreground' : ''}`}>
            {c.title}
          </span>
          {c.archived && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              <Archive className="size-3" /> Archived
            </span>
          )}
          {c.archived && c.completed && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-status-done/12 px-1.5 py-0.5 text-[11px] font-medium text-status-done">
              <CheckCircle weight="fill" className="size-3" /> Completed
            </span>
          )}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {c.archived
            ? c.list && <span>from {c.list}</span>
            : c.list && c.kind && <StatusPill col={{ name: c.list, category: c.kind, color: c.listColor ?? undefined }} />}
          {c.priority && <PriorityChip priority={c.priority} />}
          {c.labels.map((l, i) => (
            <LabelChip key={i} label={l} />
          ))}
          {c.due && <DueChip due={c.due} done={c.done} />}
          {c.subtasks > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums" title="Subtasks done">
              <ListChecks className="size-3.5" />
              {c.subtasksDone}/{c.subtasks}
            </span>
          )}
          {c.assignee && (
            <span className="inline-flex items-center gap-1">
              <Avatar name={c.assignee} className="size-4 text-[8px]" />
              <span className="max-sm:hidden">{c.assignee}</span>
            </span>
          )}
          <span className="sm:hidden" title={formatMoment(c.at)}>
            {momentWords(c.atKind, c.at, now)}
          </span>
        </span>
        {c.snippet && (
          <span className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
            <ChatCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-2 italic">{c.snippet}</span>
          </span>
        )}
      </button>
      <span className="mt-0.5 hidden shrink-0 text-xs whitespace-nowrap text-muted-foreground sm:inline" title={formatMoment(c.at)}>
        {momentWords(c.atKind, c.at, now)}
      </span>
      {c.archived && c.canEdit && (
        <span className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 max-sm:px-2" onClick={onRestore} aria-label={`Restore ${c.title}`}>
            <ArrowCounterClockwise /> <span className="max-sm:hidden">Restore</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${c.title} for good`}
            onClick={onDelete}
          >
            <Trash />
          </Button>
        </span>
      )}
    </li>
  )
}
