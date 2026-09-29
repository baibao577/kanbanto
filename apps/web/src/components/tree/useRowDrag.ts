import { useState } from 'react'
import { useBoard } from '@/app/board-context'
import { ancestorsOf } from '@kanbanto/model/indexer'

const ROW_DRAG_TYPE = 'text/x-kanbanto-row'

/** Where a dragged row would go relative to the row under the pointer. */
export type Zone = 'before' | 'inside' | 'after'

/**
 * Drag rows of a task tree (Outline, Timeline): drop on a row's top part to go before it, its bottom part
 * to go after it, or its middle to become its subtask. A task can't be dropped inside its own subtasks.
 */
export function useRowDrag(onExpand: (id: string) => void) {
  const { data, run, readOnly } = useBoard()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; zone: Zone } | null>(null)

  const canDropOn = (target: string) => !!dragId && target !== dragId && !ancestorsOf(data.tasks, target).includes(dragId)

  const drop = (target: string, zone: Zone) => {
    if (!dragId) return
    if (zone === 'inside') {
      if (run({ type: 'task.move', id: dragId, parentId: target, place: { end: true } })) onExpand(target)
    } else {
      const place = zone === 'before' ? { before: target } : { after: target }
      run({ type: 'task.move', id: dragId, parentId: data.tasks[target].parentId, place })
    }
  }

  return {
    dragId,
    zoneOf: (id: string) => (dropAt?.id === id ? dropAt.zone : undefined),
    /** Spread on the element you grab. */
    dragProps: (id: string) => ({
      draggable: !readOnly,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(ROW_DRAG_TYPE, id)
        e.dataTransfer.effectAllowed = 'move'
        setDragId(id)
      },
      onDragEnd: () => {
        setDragId(null)
        setDropAt(null)
      },
    }),
    /** Spread on the whole row. */
    dropProps: (id: string) => ({
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        if (!canDropOn(id)) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        const y = (e.clientY - r.top) / r.height
        const zone: Zone = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside'
        if (dropAt?.id !== id || dropAt.zone !== zone) setDropAt({ id, zone })
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt((d) => (d?.id === id ? null : d))
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        const zone = dropAt?.id === id ? dropAt.zone : undefined
        if (!e.dataTransfer.types.includes(ROW_DRAG_TYPE) || !zone) return
        e.preventDefault()
        setDropAt(null)
        drop(id, zone)
      },
    }),
  }
}
