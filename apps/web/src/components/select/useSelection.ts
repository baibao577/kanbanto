import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBoard } from '@/app/board-context'

/**
 * The cards someone has ticked in a view, to change together (see SelectionBar). It is theirs alone and is kept by
 * the view: leaving the view or the board forgets it.
 */
export interface Selection {
  ids: ReadonlySet<string>
  size: number
  has: (id: string) => boolean
  /**
   * Ticks a card, or unticks it. With `range` (Shift held): every card between the last one ticked and this one, in
   * the order the view shows them (`order`), is ticked.
   */
  toggle: (id: string, opts?: { range?: boolean; order?: readonly string[] }) => void
  add: (ids: Iterable<string>) => void
  remove: (ids: Iterable<string>) => void
  clear: () => void
}

export function useSelection(): Selection {
  const { data } = useBoard()
  const [ids, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const last = useRef<string | null>(null)
  // A card that is gone (deleted or archived, by anyone) is no longer selected, for good: brought back by an undo,
  // or by someone else later, it doesn't slip back into a selection nobody is looking at. (Dropped as the board
  // is read, before anything is drawn with it.)
  if ([...ids].some((id) => !(id in data.tasks))) setPicked(new Set([...ids].filter((id) => id in data.tasks)))

  const toggle = useCallback<Selection['toggle']>((id, opts) => {
    const from = last.current
    last.current = id
    setPicked((now) => {
      const next = new Set(now)
      const order = opts?.order
      const a = opts?.range && from && order ? order.indexOf(from) : -1
      const b = order ? order.indexOf(id) : -1
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order![i])
      else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const add = useCallback<Selection['add']>((more) => setPicked((now) => new Set([...now, ...more])), [])
  const remove = useCallback<Selection['remove']>((gone) => {
    const out = new Set(gone)
    setPicked((now) => new Set([...now].filter((id) => !out.has(id))))
  }, [])
  const clear = useCallback(() => {
    last.current = null
    setPicked(new Set())
  }, [])

  // Esc lets go of the selection (not while typing, or while a menu or a window is open: Esc closes that).
  const some = ids.size > 0
  useEffect(() => {
    if (!some) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (document.querySelector('[role=dialog], [role=alertdialog], [role=menu], [role=listbox]')) return
      clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [some, clear])

  return useMemo(() => ({ ids, size: ids.size, has: (id: string) => ids.has(id), toggle, add, remove, clear }), [ids, toggle, add, remove, clear])
}
