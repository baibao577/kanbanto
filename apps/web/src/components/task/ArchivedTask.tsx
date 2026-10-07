import { Archive, ArrowCounterClockwise, CheckCircle, Trash } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'

/**
 * Over an archived card (which shows read-only below it): when it was archived, from which list, whether it was
 * completed then (kept for good, whatever happens to the lists), and Restore or Delete for good.
 */
export function ArchivedBanner({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, run, readOnly } = useBoard()
  const archived = data.archived ?? {}
  const t = archived[id]
  if (!t) return null
  const subtasks = Object.values(archived).filter((x) => x.parentId === id).length
  const from = t.archivedList ?? data.columns.find((c) => c.id === t.status)?.name

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/60 px-6 py-3 text-sm">
      <Archive className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">
        Archived {t.archivedAt ? formatDistanceToNow(parseISO(t.archivedAt), { addSuffix: true }) : ''}
        {from && <> from “{from}”</>}
        {t.archivedDone !== undefined && (
          <span
            className={
              t.archivedDone
                ? 'ml-2 inline-flex items-center gap-1 rounded bg-status-done/12 px-1.5 py-0.5 text-xs font-medium text-status-done'
                : 'ml-2 inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground'
            }
          >
            {t.archivedDone && <CheckCircle weight="fill" className="size-3" />}
            {t.archivedDone ? 'Completed' : 'Not completed'}
          </span>
        )}
      </span>
      {!readOnly && (
        <>
          <Button size="sm" className="h-7 gap-1.5" onClick={() => run({ type: 'task.restore', id })}>
            <ArrowCounterClockwise /> Restore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-destructive hover:text-destructive"
            onClick={() => {
              if (!confirm(`Delete “${t.title}”${subtasks ? ' and its subtasks' : ''} for good? This can’t be undone.`)) return
              if (run({ type: 'task.delete', id })) onClose()
            }}
          >
            <Trash /> Delete for good
          </Button>
        </>
      )}
    </div>
  )
}
