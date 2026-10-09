import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { BoardAccess } from '@kanbanto/model/api'
import type { Command } from '@kanbanto/model/commands'
import { parseRef } from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { BoardData } from '@kanbanto/model/types'
import { errorMessage } from '@/api/client'
import { BoardContext, type BoardContextValue } from '@/app/board-context'
import { LinksContext } from '@/app/links-context'
import { closeInboxCard, navigate, openInboxCard } from '@/app/router'
import { useInbox, type InboxPage } from '@/app/use-inbox'
import type { DropPlace } from '@/components/board/dnd'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { fileCard, saidMoved } from '@/data/fileCard'
import { prefsStoreFor } from '@/data/prefsStore'
import { useArchivedCard, useBoardStore } from '@/data/useBoardStore'
import { InboxPanel, InboxShell } from './InboxPanel'

const TaskDialog = lazy(() => import('@/components/task/TaskDialog').then((m) => ({ default: m.TaskDialog })))
const MoveToBoardDialog = lazy(() => import('@/components/task/MoveToBoardDialog').then((m) => ({ default: m.MoveToBoardDialog })))

/** Changes that are easy to miss get an "Undo" in their toast, as on a board. */
const UNDOABLE: Partial<Record<Command['type'], string>> = { 'task.delete': 'Task deleted', 'task.archive': 'Card archived' }

/**
 * Your Inbox, live beside the open page: the board itself (kept in step with the server, like an open board), its
 * panel in the page's dock (a sheet on a phone), and its cards' own windows. Mounted while the panel is open or one of
 * its cards is in the address; never on the Inbox board's own page, which already holds it.
 */
export default function InboxLive({ boardId, cardId }: { boardId: string; cardId?: string }) {
  const { open, phone, dock, page, show, refresh, setCount, setActs } = useInbox()
  const prefsStore = useMemo(() => prefsStoreFor(boardId), [boardId])
  const store = useBoardStore(boardId, prefsStore, (e) => {
    if (e.type === 'refused') toast.error(e.message, { id: 'refused' })
    else if (e.type === 'gone') refresh()
  })
  const { data, access, undo, redo } = store
  const idx = useMemo(() => (data ? indexFor(data) : null), [data])

  // The number on the button follows the panel while it's open; once it closes, the server is asked again.
  const waiting = idx ? idx.roots.filter((id) => idx.category.get(id) !== 'done').length : null
  useEffect(() => {
    if (waiting !== null) setCount(waiting)
  }, [waiting, setCount])
  useEffect(() => refresh, [refresh])

  // The card in the address (an archived one is fetched). Gone, or never there: say so, and close.
  const looking = useArchivedCard(store, cardId)
  const openId = cardId && data && (data.tasks[cardId] || data.archived?.[cardId]) ? cardId : null
  const missing = !!cardId && (!!store.error || (!!data && !looking && !openId))
  useEffect(() => {
    if (!missing) return
    toast('That card isn’t in your Inbox any more: it was deleted, or moved to a board.', { id: 'peek' })
    closeInboxCard()
  }, [missing])

  const say = useCallback((message: string | null) => {
    if (message) toast(message, { id: 'undo' })
    return message
  }, [])
  useEffect(() => () => setActs(null), [setActs])
  const can = useRef({ undo: false, redo: false })
  useEffect(() => {
    can.current = { undo: store.canUndo, redo: store.canRedo }
  }, [store.canUndo, store.canRedo])
  const run = useCallback(
    (cmd: Command) => {
      const error = store.run(cmd)
      if (error) {
        toast(error, { id: 'refused' })
        return false
      }
      setActs({
        at: Date.now(),
        undo: () => can.current.undo && (say(undo()), true),
        redo: () => can.current.redo && (say(redo()), true),
      })
      const done = cmd.type === 'task.archive' && cmd.complete ? 'Card completed and archived' : UNDOABLE[cmd.type]
      if (done) toast(done, { id: 'undo', action: { label: 'Undo', onClick: () => say(undo()) } })
      return true
    },
    [store, undo, redo, say, setActs],
  )

  // The card made and opened just now: its window starts in the title.
  const [justMade, setJustMade] = useState<string | null>(null)
  const createTask = useCallback<BoardContextValue['createTask']>(
    (parentId, fields, opts) => {
      const id = newId()
      if (!run({ type: 'task.create', id, parentId: parentId ?? null, fields, rankAfter: opts?.rankAfter })) return null
      if (opts?.open) {
        setJustMade(id)
        openInboxCard(id)
      }
      return id
    },
    [run],
  )

  // Filing: the card leaves the panel at once, and comes back if the move is refused.
  const [filing, setFiling] = useState<ReadonlySet<string>>(new Set())
  const unsaved = useRef(0)
  useEffect(() => {
    unsaved.current = store.unsaved
  }, [store.unsaved])
  const file = useCallback(
    async (taskId: string, to: InboxPage, place: DropPlace) => {
      setFiling((f) => new Set(f).add(taskId))
      try {
        // (A card typed a moment ago has to reach the server before it can be moved from there.)
        for (let i = 0; unsaved.current > 0 && i < 50; i++) await new Promise((r) => setTimeout(r, 100))
        saidMoved(await fileCard(boardId, taskId, to.boardId, place))
      } catch (e) {
        setFiling((f) => new Set([...f].filter((x) => x !== taskId)))
        toast.error(errorMessage(e))
      }
    },
    [boardId],
  )
  // Moving from a card's menu, or its window: asks where first (`toBoardId`: with the open board already picked).
  const [moving, setMoving] = useState<{ id: string; toBoardId?: string } | null>(null)

  const links = store.links
  const openLinked = useCallback(
    (ref: string) => {
      const to = parseRef(ref)
      if (!to) return
      if (to.boardId === boardId) openInboxCard(to.taskId)
      else navigate({ page: 'board', id: to.boardId, task: to.taskId })
    },
    [boardId],
  )
  const linksCtx = useMemo(() => (links ? { store: links, open: openLinked } : null), [links, openLinked])

  const sheet = (panel: React.ReactNode) => (
    <Dialog open onOpenChange={(o) => !o && show(false)}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-[min(22rem,calc(100vw-2.5rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Inbox</DialogTitle>
        <DialogDescription className="sr-only">Quick notes and cards that have no board yet.</DialogDescription>
        {panel}
      </DialogContent>
    </Dialog>
  )
  const place = (panel: React.ReactNode) => (!open ? null : phone ? sheet(panel) : dock ? createPortal(panel, dock) : null)

  if (!data || !access || !idx || !links) return place(<InboxShell loading={!store.error} />)

  const ctx: BoardContextValue = {
    data,
    prefs: store.prefs,
    setPrefs: store.setPrefs,
    idx,
    run,
    // (Nothing here adds cards from a spreadsheet: that's on the board itself.)
    adopt: (seq, changes) => store.adopt(seq, changes),
    undo: () => void say(undo()),
    reload: store.reload,
    access,
    readOnly: access.role === 'viewer' || !!access.archivedAt,
    // (Nothing to share: it's yours alone.)
    openShare: () => {},
    counts: store.counts,
    canComment: store.canComment,
    onActivity: store.onActivity,
    openTask: openInboxCard,
    moveToBoard: (id) => setMoving({ id }),
    createTask,
    focus: (id) => navigate({ page: 'board', id: boardId, focus: id }),
    memberName: (id) => (id ? (idx.members.get(id)?.name ?? '') : ''),
    links,
    canBeLinked: store.canBeLinked,
    writing: store.docLink ? { link: store.docLink, writers: store.writers, save: store.saveWriting } : undefined,
    // (Card templates are a board's own, used on its own page.)
    templates: [],
    addFromTemplate: () => null,
  }
  return (
    <BoardContext.Provider value={ctx as BoardContextValue & { data: BoardData; access: BoardAccess }}>
      <LinksContext.Provider value={linksCtx}>
        {place(
          <InboxPanel
            filing={filing}
            onFile={(id, at) => (page ? file(id, page, at) : Promise.resolve())}
            onMoveHere={(id) => page && setMoving({ id, toBoardId: page.boardId })}
          />,
        )}
        {openId && (
          <Suspense fallback={null}>
            <TaskDialog id={openId} onClose={closeInboxCard} editTitle={openId === justMade} />
          </Suspense>
        )}
        {moving && data.tasks[moving.id] && (
          <Suspense fallback={null}>
            <MoveToBoardDialog
              taskId={moving.id}
              toBoardId={moving.toBoardId}
              onClose={() => setMoving(null)}
              onMoved={() => {
                setMoving(null)
                if (openId) closeInboxCard()
              }}
            />
          </Suspense>
        )}
      </LinksContext.Provider>
    </BoardContext.Provider>
  )
}
