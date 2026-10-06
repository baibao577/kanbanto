import { useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { newId } from '@kanbanto/model/ids'
import { COMPLETE_IN_TRELLO, fromTrello, slimTrello, type TrelloSummary } from '@kanbanto/model/trello'
import { CATEGORIES, CATEGORY_LABEL, type Category } from '@kanbanto/model/types'
import { api, errorMessage } from '@/api/client'
import { navigate } from '@/app/router'
import { StatusDot } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const named = (names: string[]) => names.map((n) => `“${n}”`).join(', ')

/**
 * A Trello board about to be imported: what will come over, what each list counts as (guessed from its name, and
 * changed here), and what stays behind. Nothing is sent until "Import board"; the file is read in the browser, and
 * only the parts that are used are sent.
 */
export function TrelloImportDialog({ file, onClose }: { file: unknown; onClose: () => void }) {
  const slim = useMemo(() => slimTrello(file), [file])
  const [said, setSaid] = useState<Record<string, Category>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => new Date().toISOString())

  // (The server reads the file again its own way: this is only to show what it will do.)
  const read = useMemo((): { summary: TrelloSummary } | { problem: string } => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return { summary: fromTrello(slim, { boardId: 'preview', now, newId, categories: said, zone }).summary }
    } catch (e) {
      return { problem: errorMessage(e) }
    }
  }, [slim, said, now])
  const s = 'summary' in read ? read.summary : null

  const run = async () => {
    if (!s) return
    setBusy(true)
    setError(null)
    try {
      const lists = Object.fromEntries(s.lists.map((l) => [l.id, l.category]))
      const { id, lost = [] } = await api<{ id: string; lost?: string[] }>('POST', '/boards/import', { file: slim, lists })
      toast(`Imported “${s.name}” from Trello`, {
        description: lost.length
          ? `You have as many fields as there can be, so ${named(lost)} ${lost.length === 1 ? 'is' : 'are'} written on the cards as text.`
          : undefined,
      })
      onClose()
      navigate({ page: 'board', id })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const comes = s
    ? [
        `${count(s.cards, 'card')} in ${count(s.lists.length, 'list')}`,
        s.archived ? count(s.archived, 'archived card') : '',
        s.subtasks ? `${count(s.subtasks, 'subtask')} (from checklists)` : '',
        s.comments ? count(s.comments, 'comment') : '',
        s.labels ? count(s.labels, 'label') : '',
        s.fields.length ? `${count(s.fields.length, 'field')} (${s.fields.join(', ')})` : '',
      ].filter(Boolean)
    : []
  const stays: ReactNode[] = s
    ? [
        s.left.files > 0 &&
          `${count(s.left.files, 'file')} uploaded to Trello ${s.left.files === 1 ? 'stays' : 'stay'} there. Each card links to its own; the links open while you’re signed in to Trello.`,
        s.left.people > 0 &&
          `People aren’t brought over. ${count(s.left.people, 'card')} ${s.left.people === 1 ? 'says' : 'say'} who ${s.left.people === 1 ? 'it was' : 'they were'} assigned to in Trello.`,
        s.comments > 0 && 'Comments arrive in your name, each saying who wrote it, with the date it was written.',
        s.left.missingComments > 0 &&
          `${count(s.left.missingComments, 'older comment')} ${s.left.missingComments === 1 ? 'isn’t' : 'aren’t'} in the file: Trello only exports a board’s latest activity.`,
        s.left.closedLists.length > 0 &&
          `${count(s.left.closedLists.length, 'archived list')} ${s.left.closedLists.length === 1 ? 'isn’t' : 'aren’t'} made (${named(s.left.closedLists)}): ${s.left.closedLists.length === 1 ? 'its' : 'their'} cards arrive archived.`,
        s.left.doneListAdded && 'A “Done” list is added, for the checklist items that were ticked.',
        s.left.completeLabel > 0 &&
          `${count(s.left.completeLabel, 'card')} marked complete in Trello ${s.left.completeLabel === 1 ? 'isn’t' : 'aren’t'} in a finished list: ${s.left.completeLabel === 1 ? 'it gets' : 'they get'} the label “${COMPLETE_IN_TRELLO}”.`,
        s.left.fieldsAsText.length > 0 &&
          `A board holds 20 fields: ${named(s.left.fieldsAsText)} ${s.left.fieldsAsText.length === 1 ? 'is' : 'are'} written on the cards as text.`,
        s.left.cut > 0 && `${count(s.left.cut, 'text')} too long to hold ${s.left.cut === 1 ? 'is' : 'are'} shortened.`,
        'Covers, stickers, votes and Power-Up data aren’t brought.',
      ].filter(Boolean)
    : []

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import “{slim.name.trim() || 'Trello board'}” from Trello</DialogTitle>
          <DialogDescription>It becomes a new board in Personal. Nothing changes in Trello.</DialogDescription>
        </DialogHeader>
        {'problem' in read ? (
          <p className="text-sm text-destructive">{read.problem}</p>
        ) : (
          <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 text-sm">
            <section>
              <h3 className="mb-1 font-medium">What comes over</h3>
              <p className="text-muted-foreground">{comes.join(' · ')}</p>
            </section>
            {s!.lists.length > 0 && (
              <section>
                <h3 className="font-medium">Lists</h3>
                <p className="mb-2 text-muted-foreground">
                  What the cards in each list are, read from its name where it says. Change any that’s wrong; you can also do it later, from the
                  list’s menu.
                </p>
                <ul className="divide-y rounded-md border">
                  {s!.lists.map((l) => (
                    <li key={l.id} className="flex items-center gap-2 py-1 pr-1 pl-3">
                      <span className="min-w-0 flex-1 truncate">{l.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count(l.cards, 'card')}</span>
                      <Select value={l.category} onValueChange={(v) => setSaid((was) => ({ ...was, [l.id]: v as Category }))}>
                        <SelectTrigger size="sm" className="w-36 shrink-0" aria-label={`Cards in “${l.name}” are`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              <StatusDot category={c} /> {CATEGORY_LABEL[c]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="mb-1 font-medium">What stays behind or changes</h3>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                {stays.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </section>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !s} onClick={() => void run()}>
            {busy ? 'Importing…' : 'Import board'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
