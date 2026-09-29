import { ArrowDown, ChatCircle, Crosshair, ListChecks, Paperclip, Prohibit } from '@phosphor-icons/react'
import { memo } from 'react'
import { Avatar, DueChip, LabelChip, ProgressBar, StatusDot, StatusPill } from '@/components/common/bits'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ancestorsOf, isBlocked, statusCol, type TaskIndex } from '@kanbanto/model/indexer'
import type { LabelDef, ViewConfig } from '@kanbanto/model/types'
import { CARD_DRAG_TYPE, dragging } from './dnd'

const CHECKLIST_MAX = 5

interface Props {
  id: string
  idx: TaskIndex
  config: ViewConfig
  labelById: Map<string, LabelDef>
  onOpen: (id: string) => void
  onFocus: (id: string) => void
  onDragEnd: () => void
  /** Set when this task also has its own row on the board. */
  onJumpToRow?: (id: string) => void
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
  onDragEnd,
  onJumpToRow,
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
  const path = d.includes('label') && t.parentId ? ancestorsOf(idx.tasks, id).map((a) => idx.tasks[a].title) : null
  const labels = t.labels.map((l) => labelById.get(l)).filter((l) => !!l)

  return (
    <article
      data-card-id={id}
      draggable={!readOnly}
      tabIndex={0}
      aria-label={t.title}
      onClick={() => onOpen(id)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onOpen(id)}
      onDragStart={(e) => {
        e.dataTransfer.setData(CARD_DRAG_TYPE, id)
        e.dataTransfer.effectAllowed = 'move'
        dragging.card = id
        dragging.height = e.currentTarget.offsetHeight
        // Dim the card after the browser has taken its drag image.
        const el = e.currentTarget
        requestAnimationFrame(() => el.classList.add('opacity-40'))
      }}
      onDragEnd={(e) => {
        e.currentTarget.classList.remove('opacity-40')
        dragging.card = null
        onDragEnd()
      }}
      className="group/card relative cursor-pointer rounded-lg border border-(--card-edge) bg-(--tile) px-3 py-2.5 text-card-foreground shadow-xs transition-[border-color,box-shadow,opacity] outline-none hover:border-foreground/20 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 pr-12">
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}

      {path && <p className={cn('mb-0.5 truncate text-[11px] leading-4 text-muted-foreground', !labels.length && 'pr-12')}>{path.join(' › ')}</p>}

      <p className={cn('text-sm leading-snug break-words', kids && 'font-medium')}>{t.title}</p>

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

      {(config.columns === 'parent' || blocked || t.due || (kids && !d.includes('progress')) || t.assigneeId || comments > 0 || files > 0) && (
        <footer className="mt-2 flex flex-wrap items-center gap-1.5">
          {config.columns === 'parent' && <StatusPill col={col} />}
          {blocked && (
            <span className="inline-flex h-5 items-center gap-1 rounded bg-warning/12 px-1.5 text-[11px] font-medium text-warning">
              <Prohibit weight="bold" className="size-3" /> Waiting
            </span>
          )}
          {t.due && <DueChip due={t.due} done={col.category === 'done'} />}
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

      {/* Hover actions */}
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100">
        {onJumpToRow && (
          <CardAction label="Go to its row" onClick={() => onJumpToRow(id)}>
            <ArrowDown className="size-3.5" />
          </CardAction>
        )}
        {kids && (
          <CardAction label="Focus on its subtasks" onClick={() => onFocus(id)}>
            <Crosshair className="size-3.5" />
          </CardAction>
        )}
      </div>
    </article>
  )
})

function CardAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          className="grid size-6 place-items-center rounded-md border border-border/70 bg-(--tile) text-muted-foreground shadow-xs hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
