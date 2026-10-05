import { ArrowSquareOut, Eye } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Command } from '@kanbanto/model/commands'
import { parseRef } from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import { BoardContext, type BoardContextValue } from '@/app/board-context'
import { LinksContext } from '@/app/links-context'
import { hrefFor, navigate } from '@/app/router'
import { TaskDialog } from '@/components/task/TaskDialog'
import { prefsStoreFor } from '@/data/prefsStore'
import { useArchivedCard, useBoardStore } from '@/data/useBoardStore'

/**
 * A card from another board, opened in place (the Search cards page, a linked card): the same card dialog as on its
 * board, kept live. Going somewhere on its board (focusing, moving it to another board) opens the board. `viewOnly`:
 * for looking, whatever your role there; nothing on it can be changed, and a bar on top leads to the card on its
 * board. A card it links to on yet another board is handed to `onOpenLinked` (or opened on its board, without one).
 * If the board can't be opened, or the card is gone, it says so and closes.
 */
export function CardPeek({
  boardId,
  taskId,
  viewOnly,
  onClose,
  onOpenLinked,
}: {
  boardId: string
  taskId: string
  viewOnly?: boolean
  onClose: () => void
  onOpenLinked?: (to: { boardId: string; taskId: string }) => void
}) {
  const prefsStore = useMemo(() => prefsStoreFor(boardId), [boardId])
  const store = useBoardStore(boardId, prefsStore, (e) => {
    if (e.type === 'refused') toast.error(e.message, { id: 'refused' })
    else onClose()
  })
  const [openId, setOpenId] = useState(taskId)
  // (An archived card isn't sent with its board: it's fetched.)
  const looking = useArchivedCard(store, openId)
  const { data, access } = store
  const idx = useMemo(() => (data ? indexFor(data) : null), [data])

  // Nothing to show: the board can't be opened, or the card isn't on it (not even archived). Say so, and close.
  const missing = !!store.error || (!!data && !looking && !data.tasks[openId] && !data.archived?.[openId])
  useEffect(() => {
    if (!missing) return
    toast('That card can’t be opened: it was deleted, or you can’t open its board.', { id: 'peek' })
    onClose()
  }, [missing, onClose])

  const links = store.links
  const openLinked = useCallback(
    (ref: string) => {
      const to = parseRef(ref)
      if (!to) return
      if (to.boardId === boardId) setOpenId(to.taskId)
      else if (onOpenLinked) onOpenLinked(to)
      else navigate({ page: 'board', id: to.boardId, task: to.taskId })
    },
    [boardId, onOpenLinked],
  )
  const linksCtx = useMemo(() => (links ? { store: links, open: openLinked } : null), [links, openLinked])

  const run = useCallback(
    (cmd: Command) => {
      if (viewOnly) return false
      const error = store.run(cmd)
      if (error) toast(error, { id: 'refused' })
      return !error
    },
    [store, viewOnly],
  )
  if (!data || !access || !idx || !links || missing) return null

  const toBoard = (patch: { task?: string; focus?: string }) => navigate({ page: 'board', id: boardId, ...patch })
  const ctx: BoardContextValue = {
    data,
    prefs: store.prefs,
    setPrefs: store.setPrefs,
    idx,
    run,
    undo: () => void store.undo(),
    reload: store.reload,
    access,
    readOnly: !!viewOnly || access.role === 'viewer' || !!access.archivedAt,
    openShare: () => toBoard({}),
    counts: store.counts,
    canComment: !viewOnly && store.canComment,
    onActivity: store.onActivity,
    openTask: setOpenId,
    moveToBoard: (id) => toBoard({ task: id }),
    createTask: (parentId, fields) => {
      const id = newId()
      return run({ type: 'task.create', id, parentId: parentId ?? null, fields }) ? id : null
    },
    focus: (id) => toBoard({ focus: id }),
    memberName: (id) => (id ? (idx.members.get(id)?.name ?? '') : ''),
    links,
    canBeLinked: store.canBeLinked,
  }
  return (
    <BoardContext.Provider value={ctx}>
      <LinksContext.Provider value={linksCtx}>
        <TaskDialog
          id={openId}
          onClose={onClose}
          banner={
            viewOnly && (
              <div className="flex items-center gap-2 border-b bg-muted/60 px-6 py-2.5 pr-12 text-xs text-muted-foreground">
                <Eye className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  View only, on <span className="font-medium text-foreground">{data.board.name}</span>
                </span>
                <a
                  href={hrefFor({ page: 'board', id: boardId, task: openId })}
                  className="inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open on board <ArrowSquareOut className="size-3.5" />
                </a>
              </div>
            )
          }
        />
      </LinksContext.Provider>
    </BoardContext.Provider>
  )
}
