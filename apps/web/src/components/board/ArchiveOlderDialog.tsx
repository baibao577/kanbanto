import { useState } from 'react'
import { toast } from 'sonner'
import { useBoard } from '@/app/board-context'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { useNow } from '@/lib/useNow'
import { doneBefore } from '@kanbanto/model/commands'
import { descendantsOf } from '@kanbanto/model/indexer'
import { DONE_DAYS, type StatusColumn } from '@kanbanto/model/types'

const DAY = 86_400_000

/**
 * "Archive older cards" for a done list: puts away, in one go, its cards that got done more than so many days ago
 * (each with its subtasks). It says how many would go before anything does; Undo brings them back.
 */
export function ArchiveOlderDialog({ col, open, onOpenChange }: { col: StatusColumn; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { idx, prefs, run, undo } = useBoard()
  // Starts at what a recent done list already hides.
  const [days, setDays] = useState(prefs.display.board.doneDays ?? DONE_DAYS)
  const now = useNow()
  const before = now - days * DAY

  const going = open ? doneBefore(idx, col.id, before) : []
  const away = new Set(going.flatMap((id) => [id, ...descendantsOf(idx, id)]))
  const subtasks = away.size - going.length
  // Finished cards of this list that are part of work still going on: they stay.
  const staying = open ? idx.preorder.filter((id) => idx.status.get(id) === col.id && idx.doneAt.get(id)! < before && !away.has(id)).length : 0
  const cards = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}`

  const archive = () => {
    if (!run({ type: 'tasks.archiveDone', status: col.id, before: new Date(before).toISOString() })) return
    toast(`${cards(going.length)} archived`, { id: 'undo', action: { label: 'Undo', onClick: undo } })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive older cards in “{col.name}”</AlertDialogTitle>
          <AlertDialogDescription>
            Archived cards leave the board and its counts. They’re kept, with their comments and files: find and restore them under Archived cards in
            the board’s menu.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          Cards done more than
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={3650}
            aria-label="Days since a card was done"
            value={days}
            onChange={(e) => setDays(Math.min(3650, Math.max(0, Math.round(Number(e.target.value)) || 0)))}
            className="h-8 w-20 px-2"
          />
          {days === 1 ? 'day' : 'days'} ago
        </label>
        <p className="text-sm" aria-live="polite">
          {going.length ? (
            <>
              <span className="font-medium">{cards(going.length)}</span> will be archived
              {subtasks > 0 && `, with ${subtasks === 1 ? 'its subtask' : `their ${subtasks.toLocaleString()} subtasks`}`}.
            </>
          ) : (
            <span className="text-muted-foreground">No cards in this list were done that long ago.</span>
          )}
          {staying > 0 && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {cards(staying)} done that long ago {staying === 1 ? 'stays: it’s' : 'stay: they’re'} part of work that isn’t finished yet.
            </span>
          )}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!going.length} onClick={archive}>
            {going.length ? `Archive ${cards(going.length)}` : 'Archive'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
