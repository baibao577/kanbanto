import { ChatCircle, ClockCounterClockwise } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CardHistory, CardHistoryEntry } from '@kanbanto/model/api'
import { OWN_DATE } from '@kanbanto/model/activity'
import { api } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Avatar } from '@/components/common/bits'
import type { CardComments } from '@/data/cardComments'
import type { CardFiles } from '@/data/cardFiles'
import { formatDay, formatMoment } from '@/lib/format'
import { cn } from '@/lib/utils'
import { stretches } from './cardHistory'
import { CommentsSection } from './Comments'

type Tab = 'comments' | 'history'

/**
 * Beside the card (its own column on wide screens, its last section otherwise): what was said about it and what
 * happened to it, as two tabs. Comments stay as they were while History is looked at, with whatever is being written.
 * Visitors with the board's public link get the comments alone: a board's log is for its people.
 */
export function CardActivity({
  taskId,
  cardFiles,
  comments,
  onOpenPassage,
  column,
}: {
  taskId: string
  cardFiles: CardFiles
  /** The card's comments, and how the words one is about are shown in the description (see CommentsSection). */
  comments: CardComments
  onOpenPassage?: (commentId: string) => void
  column?: boolean
}) {
  const { access, counts } = useBoard()
  const [tab, setTab] = useState<Tab>('comments')
  const said = <CommentsSection taskId={taskId} cardFiles={cardFiles} comments={comments} onOpenPassage={onOpenPassage} column={column} />
  if (access.via === 'public') return said
  const n = counts.comments[taskId] ?? 0
  const button = (id: Tab, label: string, icon: ReactNode, count?: number) => (
    <button
      type="button"
      role="tab"
      id={`card-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`card-panel-${id}`}
      onClick={() => setTab(id)}
      className={cn(
        'flex h-7 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4',
        tab === id && 'bg-popover text-foreground shadow-xs',
      )}
    >
      {icon} {label}
      {!!count && <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>}
    </button>
  )
  return (
    <div className={cn(column && 'flex min-h-0 flex-1 flex-col')}>
      <div role="tablist" aria-label="Comments and history" className="mb-3 grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {button('comments', 'Comments', <ChatCircle />, n)}
        {button('history', 'History', <ClockCounterClockwise />)}
      </div>
      <div
        role="tabpanel"
        id="card-panel-comments"
        aria-labelledby="card-tab-comments"
        className={cn(column && 'flex min-h-0 flex-1 flex-col', tab !== 'comments' && 'hidden')}
      >
        <CommentsSection taskId={taskId} cardFiles={cardFiles} comments={comments} onOpenPassage={onOpenPassage} column={column} bare />
      </div>
      {tab === 'history' && (
        <div role="tabpanel" id="card-panel-history" aria-labelledby="card-tab-history" className={cn(column && 'flex min-h-0 flex-1 flex-col')}>
          <History taskId={taskId} column={column} />
        </div>
      )}
    </div>
  )
}

/** Lines of one stretch of changes shown before "and 4 more". */
const SHOWN = 4

/** A line with its date, if it has one, in the reader's own words ("set it due Tue 20 Oct · 17:00"). */
const words = (l: CardHistoryEntry['lines'][number]) => (l.date ? l.text.replace(OWN_DATE, formatDay(l.date, true)) : l.text)

/**
 * What happened to the card, newest first: who did what, when, and through which app when it wasn't the website. It
 * comes from the board's activity log, so it goes back as far as that does, and follows the card as it changes.
 */
function History({ taskId, column }: { taskId: string; column?: boolean }) {
  const { data, onActivity } = useBoard()
  const boardId = data.board.id
  // (With its cover: that changes without the card counting as edited.)
  const card = data.tasks[taskId] ?? data.archived?.[taskId]
  const version = `${card?.version}:${card?.cover ?? ''}`
  const [entries, setEntries] = useState<CardHistoryEntry[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const address = `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/activity`

  const load = useCallback(
    () =>
      api<CardHistory>('GET', `${address}?limit=50`).then(
        (h) => {
          setEntries(h.entries)
          setNext(h.nextUntil)
          setFailed(false)
        },
        () => setFailed(true),
      ),
    [address],
  )
  // When the tab opens, and again a moment after the card changes (a change's line is written with it), or when a
  // file is attached or removed, or its logged time changes.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    timer.current = setTimeout(() => void load(), entries === null ? 0 : 300)
    return () => clearTimeout(timer.current)
    // (Not on `entries`: it's only read to tell the first load from the later ones.)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [load, version])
  useEffect(() => onActivity((m) => (m.type === 'attachment' || m.type === 'time') && m.taskId === taskId && void load()), [onActivity, taskId, load])

  const earlier = () =>
    next &&
    api<CardHistory>('GET', `${address}?limit=50&until=${encodeURIComponent(next)}`).then(
      (h) => {
        setEntries((xs) => [...(xs ?? []), ...h.entries])
        setNext(h.nextUntil)
      },
      () => setFailed(true),
    )

  if (entries === null)
    return (
      <p className="text-xs text-muted-foreground">{failed ? 'The history couldn’t be loaded. Close the card and open it again.' : 'Loading…'}</p>
    )
  const list = stretches(entries)
  return (
    <div className={cn(column && '-mr-3 min-h-0 flex-1 overflow-y-auto pr-3 pb-2')}>
      {!list.length && <p className="text-xs text-muted-foreground">Nothing has happened to this card in the last 180 days.</p>}
      <ol className="space-y-4" aria-label="History">
        {list.map((s) => {
          const name = s.actor?.name ?? 'Someone'
          const all = open.has(s.key) || s.lines.length <= SHOWN
          const lines = all ? s.lines : s.lines.slice(0, SHOWN - 1)
          return (
            <li key={s.key} className="flex gap-3">
              <Avatar name={name} picture={s.actor?.picture} className="mt-0.5 size-7 text-[10px]" />
              <div className="min-w-0 flex-1 text-sm">
                {s.lines.length === 1 ? (
                  <p className="break-words">
                    <span className="font-semibold">{name}</span> {words(s.lines[0])}
                  </p>
                ) : (
                  <>
                    <p className="font-semibold">{name}</p>
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-4 marker:text-muted-foreground/60">
                      {lines.map((l, i) => (
                        <li key={i} className="break-words">
                          {words(l)}
                        </li>
                      ))}
                    </ul>
                    {!all && (
                      <button
                        type="button"
                        className="mt-0.5 pl-4 text-xs font-medium text-primary hover:underline"
                        onClick={() => setOpen((o) => new Set(o).add(s.key))}
                      >
                        and {s.lines.length - lines.length} more
                      </button>
                    )}
                  </>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span title={formatMoment(s.at)}>{formatDistanceToNow(parseISO(s.at), { addSuffix: true })}</span>
                  {s.via && <> · through {s.via}</>}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
      {next ? (
        <button type="button" className="mt-4 text-xs font-medium text-primary hover:underline" onClick={() => void earlier()}>
          Show earlier
        </button>
      ) : (
        list.length > 0 && <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">History goes back 180 days.</p>
      )}
    </div>
  )
}
