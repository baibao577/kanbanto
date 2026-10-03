import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PlanningView } from '@kanbanto/model/api'
import { invertPlanChanges, type PlanChange, type PlanCommand } from '@kanbanto/model/planningCommands'
import { api, ApiError } from '@/api/client'
import { PlanSync, type PlanEvent, type PlanState } from './planSync'

const HISTORY = 200
const EMPTY = () => () => {}

/** A workspace's plan: its data (kept in step with the server by PlanSync) and undo/redo of the changes made here. */
export function usePlanStore(workspaceId: string, me: string, onEvent: (e: PlanEvent) => void) {
  const [sync, setSync] = useState<PlanSync | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const history = useRef<{ undo: PlanChange[][]; redo: PlanChange[][] }>({ undo: [], redo: [] })
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })
  const touch = () => setDepth({ undo: history.current.undo.length, redo: history.current.redo.length })
  const eventRef = useRef(onEvent)
  useEffect(() => {
    eventRef.current = onEvent
  })

  useEffect(() => {
    let alive = true
    let opened: PlanSync | null = null
    let off = () => {}
    api<PlanningView>('GET', `/workspaces/${workspaceId}/planning`).then(
      (view) => {
        if (!alive) return
        opened = new PlanSync(workspaceId, view, me)
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
  }, [workspaceId, me])

  const state: PlanState | null = useSyncExternalStore(sync?.subscribe ?? EMPTY, () => sync?.getState() ?? null)

  // Closing the tab while changes are still on their way: ask first.
  useEffect(() => {
    if (!state?.unsaved) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state?.unsaved])

  /** Runs a command. Returns why it isn't allowed, or null (it's shown at once and saved in the background). */
  const run = useCallback(
    (cmd: PlanCommand): string | null => {
      if (!sync) return 'The plan is still loading.'
      const r = sync.run(cmd)
      if ('error' in r) return r.error
      if (!r.changes.length) return null
      const h = history.current
      h.undo.push(r.changes)
      if (h.undo.length > HISTORY) h.undo.shift()
      h.redo = []
      touch()
      return null
    },
    [sync],
  )

  /** Undo or redo, as a restore the server checks like any change (refused if someone changed those records since). */
  const step = useCallback(
    (from: 'undo' | 'redo'): string | null => {
      const changes = history.current[from].pop()
      if (!sync || !changes) return from === 'undo' ? 'Nothing to undo' : 'Nothing to redo'
      const inverse = invertPlanChanges(sync.getState().plan, changes, new Date().toISOString())
      const r = sync.run({ type: 'plan.restore', changes: inverse })
      touch()
      if ('error' in r) return r.error
      history.current[from === 'undo' ? 'redo' : 'undo'].push(r.changes)
      touch()
      return null
    },
    [sync],
  )

  return {
    state,
    error,
    run,
    /** While dragging: hold off fetching other people's changes. */
    setBusy: useCallback((busy: boolean) => sync?.setBusy(busy), [sync]),
    undo: useCallback(() => step('undo'), [step]),
    redo: useCallback(() => step('redo'), [step]),
    canUndo: depth.undo > 0,
    canRedo: depth.redo > 0,
  }
}
