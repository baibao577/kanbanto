import { useCallback, useEffect, useState } from 'react'
import type { BoardSummary } from '@kanbanto/model/api'
import { toast } from 'sonner'
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
  /** Stars or unstars a board as one of your favourites (shown at once; put back if it doesn't save). */
  const setFavorite = useCallback(
    async (id: string, on: boolean) => {
      setBoards((bs) => bs && bs.map((b) => (b.id === id ? { ...b, favoritedAt: on ? new Date().toISOString() : null } : b)))
      try {
        await api('PUT', `/boards/${id}/favorite`, { favorite: on })
      } catch (e) {
        toast.error(errorMessage(e))
        void reload()
      }
    },
    [reload],
  )
  return { boards, error, reload, setFavorite }
}

/** Your favourite boards (not archived), in the order you starred them. */
export const favoritesOf = (boards: BoardSummary[] | null) =>
  (boards ?? []).filter((b) => b.favoritedAt && !b.archivedAt).sort((a, b) => a.favoritedAt!.localeCompare(b.favoritedAt!))
