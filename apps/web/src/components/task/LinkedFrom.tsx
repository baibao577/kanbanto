import { LinkSimple } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { LinkedFrom } from '@kanbanto/model/api'
import { linkRef } from '@kanbanto/model/fields'
import { api } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { useLinks } from '@/app/links-context'
import { BoardDot, StatusDot, StatusPill } from '@/components/common/bits'
import { Section } from './Section'

/**
 * The cards that link to this one through a card link field, grouped by where they link from ("Deals", from the
 * Sales pipeline board), with what their numbers add up to. Read when the card opens: it isn't kept live. Nothing at
 * all when no card links to it (or no card link is in use around this board, when it doesn't even ask).
 */
export function LinkedFromSection({ taskId }: { taskId: string }) {
  const { data, canBeLinked } = useBoard()
  const links = useLinks()
  const boardId = data.board.id
  const [from, setFrom] = useState<LinkedFrom | null>(null)
  useEffect(() => {
    if (!canBeLinked) return
    let alive = true
    api<LinkedFrom>('GET', `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/linked-from`).then(
      (r) => alive && setFrom(r),
      () => {},
    )
    return () => {
      alive = false
    }
  }, [boardId, taskId, canBeLinked])
  const count = from ? from.groups.reduce((n, g) => n + g.count, 0) + from.hidden : 0
  if (!from || !count) return null
  return (
    <Section icon={<LinkSimple />} title="Linked from" count={count}>
      <div className="space-y-4">
        {from.groups.map((g) => (
          <div key={`${g.board.id}:${g.field.id}`}>
            <p className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-sm">
              <span className="font-medium">{g.field.back || g.field.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <BoardDot background={g.board.background} />
                <span className="truncate">
                  {g.board.name}
                  {g.field.back && ` · ${g.field.name}`}
                </span>
              </span>
              {g.totals.length > 0 && (
                <span className="ml-auto flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {g.totals.map((t) => (
                    <span key={t.name}>
                      {t.name} <span className="font-medium text-foreground/80 tabular-nums">{t.text}</span>
                    </span>
                  ))}
                </span>
              )}
            </p>
            <ul className="space-y-0.5">
              {g.cards.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                  <StatusDot category={c.kind} />
                  <button
                    type="button"
                    onClick={() => links?.open(linkRef(g.board.id, c.id))}
                    className={`min-w-0 flex-1 truncate text-left text-sm hover:underline ${c.done ? 'text-muted-foreground' : ''}`}
                  >
                    {c.title}
                  </button>
                  <StatusPill col={{ name: c.list, category: c.kind }} />
                </li>
              ))}
            </ul>
            {g.count > g.cards.length && <p className="px-1 pt-1 text-xs text-muted-foreground">And {g.count - g.cards.length} more.</p>}
          </div>
        ))}
        {from.hidden > 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            {from.groups.length ? 'And ' : ''}
            {from.hidden === 1 ? '1 card' : `${from.hidden} cards`} on boards you can’t open.
          </p>
        )}
      </div>
    </Section>
  )
}
