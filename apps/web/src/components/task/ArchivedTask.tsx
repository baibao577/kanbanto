import { Archive, ArrowCounterClockwise, Trash } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useBoard } from '@/app/board-context'
import { Markdown } from '@/components/text/Markdown'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useCardFiles } from '@/data/cardFiles'
import type { Task } from '@kanbanto/model/types'

/**
 * An archived card, opened from a link, a notification or the Outline's "Archived" part: read-only, with what it
 * said and where it was, and Restore (back where it was, when it can be) or Delete for good.
 */
export function ArchivedTask({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, run, readOnly, onActivity } = useBoard()
  const archived = data.archived ?? {}
  const t = archived[id]
  const cardFiles = useCardFiles(data.board.id, id, onActivity)
  if (!t) return null
  const parent = t.parentId ? (data.tasks[t.parentId] ?? archived[t.parentId]) : null
  const list = data.columns.find((c) => c.id === t.status)
  const subtasks = Object.values(archived).filter((x: Task) => x.parentId === id)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/60 px-6 py-3 pr-12 text-sm">
        <Archive className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-muted-foreground">
          Archived {t.archivedAt ? formatDistanceToNow(parseISO(t.archivedAt), { addSuffix: true }) : ''}. It’s out of the board until it’s restored.
        </span>
        {!readOnly && (
          <>
            <Button
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => {
                run({ type: 'task.restore', id })
              }}
            >
              <ArrowCounterClockwise /> Restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-destructive hover:text-destructive"
              onClick={() => {
                if (!confirm(`Delete “${t.title}”${subtasks.length ? ' and its subtasks' : ''} for good? This can’t be undone.`)) return
                if (run({ type: 'task.delete', id })) onClose()
              }}
            >
              <Trash /> Delete for good
            </Button>
          </>
        )}
      </div>
      <div className="space-y-5 px-6 py-5">
        <div>
          {parent && <p className="text-xs text-muted-foreground">{parent.title}</p>}
          <DialogTitle className="text-xl font-semibold">{t.title}</DialogTitle>
          <DialogDescription className="mt-1 text-xs">Was in {list ? `“${list.name}”` : 'a list that’s gone'}.</DialogDescription>
        </div>
        {t.description ? <Markdown text={t.description} files={cardFiles.files} /> : <p className="text-sm text-muted-foreground">No description.</p>}
        {subtasks.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Subtasks (archived with it)</p>
            <ul className="space-y-1 text-sm">
              {subtasks.map((s) => (
                <li key={s.id} className="rounded-md bg-muted/50 px-2.5 py-1.5">
                  {s.title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
