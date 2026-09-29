import { useCallback, useEffect, useState } from 'react'
import type { BoardSummary } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'

const fetchBoards = () => api<{ boards: BoardSummary[] }>('GET', '/boards').then((r) => r.boards)

/** The boards you can open (null while loading). Refreshed when you come back to the tab. */
export function useBoards() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(
    () =>
      fetchBoards().then(
        (b) => {
          setBoards(b)
          setError(null)
        },
        (e) => setError(errorMessage(e)),
      ),
    [],
  )
  useEffect(() => {
    let alive = true
    fetchBoards().then(
      (b) => alive && setBoards(b),
      (e) => alive && setError(errorMessage(e)),
    )
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])
  return { boards, error, reload }
}
