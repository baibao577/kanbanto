import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { CardsPage } from '@kanbanto/model/api'
import { todayDay } from '@kanbanto/model/dates'
import { filterCount, matchesFilter } from '@kanbanto/model/table'
import { matcher } from '@kanbanto/model/view'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { useLinks } from '@/app/links-context'
import { useAuth } from '@/app/use-auth'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { exportBoard, exportSheet } from '@/data/transfer'
import { cn } from '@/lib/utils'

type Kind = 'sheet' | 'board'

/** One of the two kinds of file: its name, what it is for, and under it (while chosen) what can be said about it. */
function Choice({ value, chosen, title, hint, children }: { value: Kind; chosen: Kind; title: string; hint: string; children?: ReactNode }) {
  const on = value === chosen
  return (
    <div className={cn('rounded-lg border', on && 'border-primary/60 bg-primary/5')}>
      <label htmlFor={`export-${value}`} className="flex cursor-pointer items-start gap-3 p-3">
        <RadioGroupItem id={`export-${value}`} value={value} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      </label>
      {on && children && <div className="space-y-2.5 px-3 pb-3 pl-10">{children}</div>}
    </div>
  )
}

const Tick = ({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (on: boolean) => void; children: ReactNode }) => (
  <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm">
    <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
    <span className="min-w-0">{children}</span>
  </label>
)

/**
 * Saves the board as a file, of one of two kinds. A spreadsheet (.csv): one row for each card, for a report or to
 * add things up elsewhere; it follows the search and filter that are on, unless told not to, and can have the
 * archived cards too. Or the whole board (.json): everything, to keep or to bring back as a new board, with its
 * comments and logged time when asked.
 */
export function ExportDialog({ search, onClose }: { /** What is typed in the board's search box. */ search: string; onClose: () => void }) {
  const { data, idx, prefs, counts, access } = useBoard()
  const me = useAuth().user?.id
  const links = useLinks()
  const [kind, setKind] = useState<Kind>('sheet')
  const [onlyFound, setOnlyFound] = useState(true)
  const [withArchived, setWithArchived] = useState(false)
  const [extras, setExtras] = useState(false)
  const [busy, setBusy] = useState(false)
  // How many archived cards the board has: asked for (they aren't sent with the board).
  const [archived, setArchived] = useState(0)
  const boardId = data.board.id
  useEffect(() => {
    api<CardsPage>('GET', `/cards?state=archived&board=${encodeURIComponent(boardId)}&limit=1`).then(
      (r) => setArchived(r.total),
      () => {},
    )
  }, [boardId])

  // The cards the search and the filter find, in the outline's order: what "only the cards shown now" saves.
  const f = prefs.filter
  const found = useMemo(() => {
    const m = matcher(search, idx.fields.values(), idx.codes)
    const filtering = filterCount(f) > 0
    if (!m && !filtering) return null
    const ctx = { me, today: todayDay() }
    return idx.preorder.filter((id) => (!m || m(idx.tasks[id])) && (!filtering || matchesFilter(idx, id, f, counts.lastComment, ctx)))
  }, [idx, search, f, counts.lastComment, me])
  const all = idx.preorder.length
  // (Visitors with the public link don't see logged time, so the whole-board file can't bring it for them.)
  const member = access.via !== 'public'

  const run = async () => {
    setBusy(true)
    try {
      if (kind === 'sheet')
        await exportSheet(data, {
          ids: found && onlyFound ? found : undefined,
          order: idx.preorder,
          archived: withArchived,
          titleOf: links?.store.titleOf,
        })
      else await exportBoard(data, { extras: extras && member })
      toast('Saved to your downloads')
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  const cards = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}`

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export “{data.board.name}”</DialogTitle>
          <DialogDescription>Save the board as a file on your computer.</DialogDescription>
        </DialogHeader>
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as Kind)} className="gap-2" aria-label="The kind of file">
          <Choice
            value="sheet"
            chosen={kind}
            title="A spreadsheet (.csv)"
            hint="One row for each card, to open in Excel, Numbers or Google Sheets: for a report, or to add things up."
          >
            {found && (
              <Tick id="export-found" checked={onlyFound} onChange={setOnlyFound}>
                Only the {cards(found.length)} your search and filter find
                <span className="block text-xs text-muted-foreground">Off: all {cards(all)} on the board.</span>
              </Tick>
            )}
            {archived > 0 && (
              <Tick id="export-archived" checked={withArchived} onChange={setWithArchived}>
                With the {cards(archived)} in the archive
              </Tick>
            )}
            <p className="text-xs text-muted-foreground">
              Its columns are named the way <span className="font-medium">Import cards…</span> reads them, so a sheet can be changed and brought back.
            </p>
          </Choice>
          <Choice
            value="board"
            chosen={kind}
            title="The whole board (.json)"
            hint="Everything on the board in one file, archived cards too: to keep, or to bring back as a new board with Import a board…"
          >
            {member && (
              <Tick id="export-extras" checked={extras} onChange={setExtras}>
                With comments and logged time
                <span className="block text-xs text-muted-foreground">Files attached to cards stay behind.</span>
              </Tick>
            )}
          </Choice>
        </RadioGroup>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run()}>
            {busy ? 'Saving…' : 'Export'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
