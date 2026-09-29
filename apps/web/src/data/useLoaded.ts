import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'

/**
 * Loads something when a page or dialog opens (settings, the people on a board). A problem is shown as a message;
 * `reload` fetches it again after a change. `load` must keep its identity between renders (a module-level function,
 * or one made with useCallback), or it would load again on every render.
 */
export function useLoaded<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const reload = useCallback(() => load().then(setData, (e: unknown) => void toast.error(errorMessage(e))), [load])
  useEffect(() => {
    void reload()
  }, [reload])
  return [data, reload] as const
}
