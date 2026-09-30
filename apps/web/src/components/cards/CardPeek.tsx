import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Command } from '@kanbanto/model/commands'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import { BoardContext, type BoardContextValue } from '@/app/board-context'
import { navigate } from '@/app/router'
import { TaskDialog } from '@/components/task/TaskDialog'
import { prefsStoreFor } from '@/data/prefsStore'
import { useBoardStore } from '@/data/useBoardStore'

/**
 * A card from another board, opened in place (the Cards page): the same card dialog as on its board, kept live. An
 * archived one shows read-only with Restore and Delete; once restored, it's the ordinary card. Going somewhere on its
 * board (focusing, moving it to another board) opens the board.
 */
export function CardPeek({ boardId, taskId, onClose }: { boardId: string; taskId: string; onClose: () => void }) {
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
      const error = store.run(cmd)
      if (error) toast(error, { id: 'refused' })
      return !error
    },
    [store],
  )
  if (!data || !access || !idx) return null

  const toBoard = (patch: { task?: string; focus?: string }) => navigate({ page: 'board', id: boardId, ...patch })
  const ctx: BoardContextValue = {
    data,
    prefs: store.prefs,
    setPrefs: store.setPrefs,
    idx,
    run,
    access,
    readOnly: access.role === 'viewer' || !!access.archivedAt,
    openShare: () => toBoard({}),
    counts: store.counts,
    canComment: store.canComment,
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
      <TaskDialog id={openId} onClose={onClose} />
    </BoardContext.Provider>
  )
}
