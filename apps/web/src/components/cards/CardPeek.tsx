import { ArrowSquareOut, Eye } from '@phosphor-icons/react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import { BoardContext, type BoardContextValue } from '@/app/board-context'
import { hrefFor, navigate } from '@/app/router'
import { TaskDialog } from '@/components/task/TaskDialog'
import { prefsStoreFor } from '@/data/prefsStore'
import { useBoardStore } from '@/data/useBoardStore'

/**
 * A card from another board, opened in place (the Search cards page): the same card dialog as on its board, kept
 * live. Going somewhere on its board (focusing, moving it to another board) opens the board. `viewOnly`: for looking,
 * whatever your role there; nothing on it can be changed, and a bar on top leads to the card on its board.
 */
export function CardPeek({ boardId, taskId, viewOnly, onClose }: { boardId: string; taskId: string; viewOnly?: boolean; onClose: () => void }) {
  const prefsStore = useMemo(() => prefsStoreFor(boardId), [boardId])
  const store = useBoardStore(boardId, prefsStore, (e) => {
    if (e.type === 'refused') toast.error(e.message, { id: 'refused' })
    else onClose()
  })
  const [openId, setOpenId] = useState(taskId)
  const { data, access } = store
  const idx = useMemo(() => (data ? indexFor(data) : null), [data])

  const run = useCallback(
    (cmd: Command) => {
      if (viewOnly) return false
      const error = store.run(cmd)
      if (error) toast(error, { id: 'refused' })
      return !error
    },
    [store, viewOnly],
  )
  if (!data || !access || !idx) return null

  const toBoard = (patch: { task?: string; focus?: string }) => navigate({ page: 'board', id: boardId, ...patch })
  const ctx: BoardContextValue = {
    data,
    prefs: store.prefs,
    setPrefs: store.setPrefs,
    idx,
    run,
    undo: () => void store.undo(),
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
  }
  return (
    <BoardContext.Provider value={ctx}>
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
    </BoardContext.Provider>
  )
}
