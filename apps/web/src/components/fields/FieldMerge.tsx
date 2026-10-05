import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { FieldLibraryView, FieldMerge, FieldView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fieldSummary } from './meta'

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`)
const joinWords = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)

/**
 * Merges a field into another of the same kind: for a library that ended up with two fields for one thing ("Company"
 * and "Company name"). You pick the field to keep; before anything changes it says what will, in numbers, since
 * whoever manages a library can't always open every board that uses it. `others`: the fields it could be merged into.
 */
export function FieldMergeDialog({
  base,
  field,
  others,
  onClose,
  onMerged,
}: {
  base: string
  field: FieldView
  others: FieldView[]
  onClose: () => void
  onMerged: (library: FieldLibraryView) => void
}) {
  const [into, setInto] = useState(others.length === 1 ? others[0].id : '')
  const kept = others.find((f) => f.id === into)
  const [found, setFound] = useState<{ into: string; plan: FieldMerge } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!into) return
    let alive = true
    api<FieldMerge>('GET', `${base}/${field.id}/merge?into=${into}`).then(
      (plan) => alive && setFound({ into, plan }),
      (e) => alive && setFound({ into, plan: { cards: 0, boards: 0, both: 0, options: [], differs: [], problem: errorMessage(e) } }),
    )
    return () => {
      alive = false
    }
  }, [base, field.id, into])
  const plan = found?.into === into ? found.plan : null

  const merge = async () => {
    if (!kept) return
    setBusy(true)
    try {
      const done = await api<FieldLibraryView & { cards: number }>('POST', `${base}/${field.id}/merge`, { into })
      toast(`“${field.name}” is merged into “${kept.name}”${done.cards ? `: ${count(done.cards, 'card', 'cards')} changed` : ''}.`)
      onMerged(done)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  // What the kept field says differently, where its way will stand.
  const notes: string[] = []
  if (plan && kept) {
    if (plan.differs.includes('unit'))
      notes.push(`Numbers stay as they are, and read in “${kept.name}”’s unit (${kept.unit || 'none'}, not ${field.unit || 'none'}).`)
    if (plan.differs.includes('sum') && !kept.sum) notes.push(`“${kept.name}” doesn’t add up: the totals “${field.name}” had go.`)
    if (plan.differs.includes('many') && !kept.many) notes.push(`“${kept.name}” holds one: a card that had several keeps the first.`)
    if (plan.differs.includes('format') || plan.differs.includes('decimals')) notes.push(`Values are shown the way “${kept.name}” is set up.`)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge “{field.name}” into another field</DialogTitle>
          <DialogDescription>
            For two fields that mean the same thing. Every card’s value moves to the field you pick, boards that used “{field.name}” use that one
            instead, and “{field.name}” goes away.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="merge-into" className="text-sm font-medium">
            Keep
          </label>
          <Select value={into} onValueChange={setInto}>
            <SelectTrigger id="merge-into" className="w-full">
              <SelectValue placeholder="Pick the field to keep" />
            </SelectTrigger>
            <SelectContent>
              {others.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                  <span className="text-muted-foreground"> · {fieldSummary(f)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {kept && (
          <div className="min-h-16 space-y-1.5 rounded-lg bg-muted/60 p-3 text-sm" aria-live="polite">
            {!plan ? (
              <p className="text-muted-foreground">Counting…</p>
            ) : plan.problem ? (
              <p className="text-destructive">{plan.problem}</p>
            ) : (
              <>
                <p>
                  {plan.cards
                    ? `${count(plan.cards, 'card', 'cards')} on ${count(plan.boards, 'board', 'boards')} ${plan.cards === 1 ? 'has' : 'have'} a “${field.name}”: it becomes ${plan.cards === 1 ? 'its' : 'their'} “${kept.name}”.`
                    : `No card has a “${field.name}”: there’s nothing to move.`}
                </p>
                {plan.both > 0 && (
                  <p>
                    {plan.both === 1 ? '1 of them already has' : `${plan.both.toLocaleString('en-US')} of them already have`} a “{kept.name}” too:{' '}
                    {plan.both === 1 ? 'it keeps' : 'they keep'} the one {plan.both === 1 ? 'its board shows' : 'their board shows'}, and the other is
                    lost.
                  </p>
                )}
                {plan.options.length > 0 && (
                  <p>
                    “{kept.name}” gets {plan.options.length === 1 ? 'the option' : 'the options'} {joinWords(plan.options.map((o) => `“${o}”`))}.
                  </p>
                )}
                {notes.map((n) => (
                  <p key={n}>{n}</p>
                ))}
                <p className="text-muted-foreground">This can’t be undone.</p>
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !plan || !!plan.problem} onClick={() => void merge()}>
            Merge into {kept ? `“${kept.name}”` : 'it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
