import { useLayoutEffect, useRef, useState } from 'react'
import { useBoard } from '@/app/board-context'
import { pointerDrag } from '@/lib/pointerDrag'
import { ancestorsOf } from '@kanbanto/model/indexer'

/** Where a dragged row would go relative to the row under the pointer. */
export type Zone = 'before' | 'inside' | 'after'

/** The zone for a pointer `fraction` of the way down a row: top part, middle, or bottom part. */
export const zoneAt = (fraction: number): Zone => (fraction < 0.28 ? 'before' : fraction > 0.72 ? 'after' : 'inside')

/**
 * Drag rows of a task tree (Outline, Timeline): drop on a row's top part to go before it, its bottom part
 * to go after it, or its middle to become its subtask. A task can't be dropped inside its own subtasks.
 */
export function useRowDrag(onExpand: (id: string) => void) {
  const { data, run, readOnly } = useBoard()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; zone: Zone } | null>(null)

  const canDrop = (id: string, target: string) => target !== id && !ancestorsOf(data.tasks, target).includes(id)

  /** The row and zone under the pointer, if row `id` can go there. */
  const targetAt = (id: string, x: number, y: number) => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-row]')
    const target = row?.dataset.dropRow
    if (!row || !target || !(target in data.tasks) || !canDrop(id, target)) return null
    const r = row.getBoundingClientRect()
    return { id: target, zone: zoneAt((y - r.top) / r.height) }
  }

  const drop = (id: string, target: string, zone: Zone) => {
    if (zone === 'inside') {
      if (run({ type: 'task.move', id, parentId: target, place: { end: true } })) onExpand(target)
    } else {
      const place = zone === 'before' ? { before: target } : { after: target }
      run({ type: 'task.move', id, parentId: data.tasks[target].parentId, place })
    }
  }

  // A drag outlives the render it started in, so it calls the latest version of these.
  const live = useRef({ targetAt, drop })
  useLayoutEffect(() => {
    live.current = { targetAt, drop }
  })

  return {
    dragId,
    zoneOf: (id: string) => (dropAt?.id === id ? dropAt.zone : undefined),
    /** Spread on the element you grab (give it the `drag-handle` class). The whole row follows the pointer. */
    dragProps: (id: string) =>
      readOnly
        ? {}
        : {
            onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
              // Something opened from the row (a menu, a date picker) is drawn elsewhere on the page, but its presses
              // still arrive here: they're not a grab of the row.
              if (!e.currentTarget.contains(e.target as Node)) return
              const row = e.currentTarget.closest<HTMLElement>('[data-drop-row]') ?? e.currentTarget
              pointerDrag(e, {
                ghost: row,
                start: () => {
                  setDragId(id)
                  let last: { id: string; zone: Zone } | null = null
                  return {
                    move: (x, y) => {
                      const next = live.current.targetAt(id, x, y)
                      last = next
                      setDropAt((d) => (d?.id === next?.id && d?.zone === next?.zone ? d : next))
                    },
                    drop: () => last && live.current.drop(id, last.id, last.zone),
                    end: () => {
                      setDragId(null)
                      setDropAt(null)
                    },
                  }
                },
              })
            },
          },
    /** Spread on the whole row. */
    dropProps: (id: string) => ({ 'data-drop-row': id }),
  }
}
