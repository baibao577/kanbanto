import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { ArchivedPage, BoardSnapshot } from '@kanbanto/model/api'
import { invertChanges } from '@kanbanto/model/changes'
import type { Command } from '@kanbanto/model/commands'
import { cleanPrefs, defaultPrefs, prefsReducer } from '@kanbanto/model/prefs'
import type { Change } from '@kanbanto/model/records'
import type { BoardData } from '@kanbanto/model/types'
import { api, ApiError } from '@/api/client'
import type { PrefsStore } from './prefsStore'
import { BoardSync, type SyncEvent, type SyncState, type TaskActivity } from './sync'

const NO_COUNTS = { comments: {}, attachments: {}, lastComment: {}, time: {} }

const HISTORY = 200

export type LoadError = { status: number; message: string }

const EMPTY = () => () => {}

/**
 * One open board: its data (kept in step with the server by `BoardSync`), this person's view settings,
 * and undo/redo of the commands run here.
 */
export function useBoardStore(boardId: string, prefsStore: PrefsStore, onEvent: (e: SyncEvent) => void) {
  const [sync, setSync] = useState<BoardSync | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [prefs, setPrefs] = useReducer(prefsReducer, undefined, () => prefsStore.load() ?? defaultPrefs())
  const history = useRef<{ undo: Change[][]; redo: Change[][] }>({ undo: [], redo: [] })
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })
  const touchHistory = () => setDepth({ undo: history.current.undo.length, redo: history.current.redo.length })
  const eventRef = useRef(onEvent)
  useEffect(() => {
    eventRef.current = onEvent
  })

  useEffect(() => {
    let alive = true
    let opened: BoardSync | null = null
    let off = () => {}
    api<BoardSnapshot>('GET', `/boards/${encodeURIComponent(boardId)}`).then(
      (snap) => {
        if (!alive) return
        opened = new BoardSync(boardId, snap)
        off = opened.onEvent((e) => eventRef.current(e))
        setSync(opened)
      },
      (e) => alive && setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      alive = false
      off()
      opened?.close()
    }
  }, [boardId])

  const state: SyncState | null = useSyncExternalStore(sync?.subscribe ?? EMPTY, () => sync?.getState() ?? null)
  const data = state?.data ?? null

  useEffect(() => {
    prefsStore.save(prefs)
  }, [prefs, prefsStore])

  // Settings that point at deleted lists, labels, people or tasks are dropped.
  useEffect(() => {
    if (!data) return
    const cleaned = cleanPrefs(prefs, data)
    if (cleaned !== prefs) setPrefs({ type: 'replace', prefs: cleaned })
  }, [data, prefs])

  // Closing the tab while changes are still on their way to the server: ask first.
  useEffect(() => {
    if (!state?.unsaved) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state?.unsaved])

  /** Runs a command. Returns why it isn't allowed, or null (it's shown at once and saved in the background). */
  const run = useCallback(
    (cmd: Command): string | null => {
      if (!sync) return 'The board is still loading.'
      const r = sync.run(cmd)
      if ('error' in r) return r.error
      if (!r.changes.length) return null
      const h = history.current
      h.undo.push(r.changes)
      if (h.undo.length > HISTORY) h.undo.shift()
      h.redo = []
      touchHistory()
      return null
    },
    [sync],
  )

  /**
   * Undo or redo: puts the records back as a new command, which the server checks like any other. It's refused
   * if someone else has changed those records since. Returns null when done, or what to tell the person.
   */
  const step = useCallback(
    (from: 'undo' | 'redo'): string | null => {
      const changes = history.current[from].pop()
      if (!sync || !changes) return from === 'undo' ? 'Nothing to undo' : 'Nothing to redo'
      const inverse = invertChanges(sync.getState().data, changes, new Date().toISOString())
      const r = sync.run({ type: 'records.restore', changes: inverse })
      touchHistory()
      if ('error' in r) return r.error
      history.current[from === 'undo' ? 'redo' : 'undo'].push(r.changes)
      touchHistory()
      return null
    },
    [sync],
  )

  /** Fetches an archived card with the archived cards above and under it (see `useArchivedCard`). Quiet when there's none. */
  const loadArchived = useCallback(
    async (taskId: string) => {
      if (!sync) return
      try {
        const page = await api<ArchivedPage>('GET', `/boards/${encodeURIComponent(boardId)}/archived?task=${encodeURIComponent(taskId)}`)
        sync.learnArchived(page.tasks)
      } catch {
        // The board is gone, or the server can't be reached: there's nothing to show.
      }
    },
    [sync, boardId],
  )

  return {
    data,
    loadArchived,
    access: state?.access ?? null,
    counts: state?.counts ?? NO_COUNTS,
    canComment: state?.canComment ?? false,
    /** Comments and files changing on any card (live). */
    onActivity: useCallback((l: (m: TaskActivity) => void) => sync?.onActivity(l) ?? (() => {}), [sync]),
    connection: state?.connection ?? 'connecting',
    unsaved: state?.unsaved ?? 0,
    /** Couldn't open the board (401: sign in; 404: gone or no access). */
    error,
    prefs,
    setPrefs,
    run,
    /** Fetches the board again (after changing something that isn't a command: its fields). */
    reload: useCallback(() => void sync?.resync(), [sync]),
    undo: useCallback(() => step('undo'), [step]),
    redo: useCallback(() => step('redo'), [step]),
    canUndo: depth.undo > 0,
    canRedo: depth.redo > 0,
  }
}

/**
 * A board comes without its archived cards. When `id` isn't a card on it, this asks the server whether it's an
 * archived one, and keeps what comes back with the board (so it opens, and can be restored). True while that isn't
 * known yet.
 */
export function useArchivedCard(
  store: { data: BoardData | null; loadArchived: (taskId: string) => Promise<void> },
  id: string | null | undefined,
): boolean {
  const { data, loadArchived } = store
  const [asked, setAsked] = useState<string | null>(null)
  const missing = !!id && !!data && !data.tasks[id] && !data.archived?.[id]
  useEffect(() => {
    if (!missing || !id || asked === id) return
    let alive = true
    void loadArchived(id).then(() => alive && setAsked(id))
    return () => {
      alive = false
    }
  }, [missing, id, asked, loadArchived])
  return missing && asked !== id
}
