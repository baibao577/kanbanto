import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceSummary } from '@kanbanto/model/api'
import { api } from '@/api/client'

const fetchWorkspaces = () => api<{ workspaces: WorkspaceSummary[] }>('GET', '/workspaces').then((r) => r.workspaces)

/** The workspaces you're in (null while loading; empty if they couldn't be loaded). */
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const reload = useCallback(
    () =>
      fetchWorkspaces().then(
        (w) => setWorkspaces(w),
        () => setWorkspaces((w) => w ?? []),
      ),
    [],
  )
  useEffect(() => {
    let alive = true
    fetchWorkspaces().then(
      (w) => alive && setWorkspaces(w),
      () => alive && setWorkspaces([]),
    )
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])
  return { workspaces, reload }
}
