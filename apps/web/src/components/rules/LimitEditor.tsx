import { CaretDown } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import { newId } from '@kanbanto/model/ids'
import {
  countsFor,
  describeRule,
  hasConditions,
  limitOn,
  listOf,
  RULE_COUNTS,
  type LimitRule,
  type RuleCounts,
  type RuleFilter,
} from '@kanbanto/model/rules'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { FilterEditor } from '@/components/shell/FilterEditor'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const CARDS = 'cards'
const COUNTS: Record<RuleCounts, [string, string]> = {
  leaves: ['Cards without subtasks', 'A card that has subtasks isn’t counted: its subtasks are.'],
  topLevel: ['Top-level cards', 'A card’s subtasks aren’t counted by themselves. A number field adds theirs to it.'],
  all: ['Every card', 'A card and each of its subtasks are counted.'],
}

/** A filter with nothing left unsaid in it: no part that is empty or not there. */
const tidy = (cards: RuleFilter): RuleFilter =>
  Object.fromEntries(
    Object.entries(cards).filter(([, v]) => v !== undefined && (!Array.isArray(v) || v.length) && (typeof v !== 'object' || Object.keys(v).length)),
  )

/**
 * Makes or changes a limit (the board's owners): at most this much of these cards. What is added up, who it holds
 * and which cards count are chosen here, and under "Which cards" the lists and the conditions, said with the Filter
 * menu's own controls. Opened from a list's menu it starts about that list; from the Rules page, about the whole
 * board.
 *
 * It is saved with its button, not as you go: each save makes every open copy of the board read it again.
 */
export function LimitEditor({
  rule,
  listId,
  onClose,
}: {
  /** The limit to change; left out: a new one. */
  rule?: LimitRule
  /** For a new one: the list it starts about. */
  listId?: string
  onClose: () => void
}) {
  const { data, reload } = useBoard()
  const [start] = useState<LimitRule>(
    () => rule ?? (listId ? limitOn(newId(), listId, data.board.mode, 3) : { ...limitOn(newId(), '', data.board.mode, 3), cards: {} }),
  )
  const [name, setName] = useState(start.name ?? '')
  const [most, setMost] = useState(String(start.max ?? ''))
  const [of, setOf] = useState(start.measure.by === 'field' ? start.measure.field : CARDS)
  const [each, setEach] = useState(start.per === 'person')
  const [counts, setCounts] = useState<RuleCounts>(start.counts)
  const [cards, setCards] = useState<RuleFilter>(start.cards)
  // "Which cards" is folded away while the limit is the plain kind, about one list: the common case stays short.
  const [which, setWhich] = useState(!listOf(start) || hasConditions(start))
  const [busy, setBusy] = useState(false)
  const numbers = data.fields.filter((f) => f.type === 'number')
  const typed = Number(most.replace(',', '.'))
  // (A field's numbers are kept to its decimals, and so is a limit on it: "36 / 35.5 h" would read as "36 / 36 h".)
  const places = of === CARDS ? 0 : numbers.find((f) => f.id === of)?.decimals
  const max = places === undefined ? typed : Math.round(typed * 10 ** places) / 10 ** places
  const valid = most.trim() !== '' && Number.isFinite(typed) && typed >= 0 && (of !== CARDS || Number.isInteger(typed))
  const { per: _per, name: _name, ...kept } = start
  const draft: LimitRule = {
    ...kept,
    ...(name.trim() && { name: name.trim() }),
    cards: tidy(cards),
    measure: of === CARDS ? { by: 'cards' } : { by: 'field', field: of },
    counts,
    ...(each && { per: 'person' as const }),
    max: valid ? max : 0,
  }
  const one = listOf(draft)
  const list = one && data.columns.find((c) => c.id === one)?.name
  const address = `/boards/${data.board.id}/rules`

  const send = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await what()
      // (Everyone's copy is told to read the board again; this one doesn't wait to be told.)
      reload()
      toast(done)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  const { id: _id, ...body } = draft
  const save = () =>
    send(
      () => (rule ? api('PATCH', `${address}/${rule.id}`, { rule: body }) : api('POST', address, { rule: body })),
      rule ? 'Limit changed' : 'Limit set',
    )
  const remove = () => send(() => api('DELETE', `${address}/${rule!.id}`), 'Limit removed')

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] flex-col gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{list ? `Limit for “${list}”` : rule ? 'Limit' : 'New limit'}</DialogTitle>
          <DialogDescription>
            The board shows when there is more than this. Nothing is refused: a card can always be added. Everyone sees the same number, whatever they
            filter or hide.
          </DialogDescription>
        </DialogHeader>

        <form
          id="limit"
          className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && !busy) void save()
          }}
        >
          <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
            <label htmlFor="limit-most" className="text-muted-foreground">
              At most
            </label>
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <Input
                id="limit-most"
                inputMode="decimal"
                autoFocus
                value={most}
                onChange={(e) => setMost(e.target.value)}
                aria-invalid={!valid}
                className="tabular-nums"
              />
              <Select value={of} onValueChange={setOf}>
                <SelectTrigger aria-label="What is added up" className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CARDS}>Cards</SelectItem>
                  {numbers.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                      {f.unit ? ` (${f.unit})` : ''}, added up
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <span className="text-muted-foreground">For</span>
            <Select value={each ? 'person' : 'all'} onValueChange={(v) => setEach(v === 'person')}>
              <SelectTrigger aria-label="Who the limit holds" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{one ? 'The whole list' : 'All of them together'}</SelectItem>
                <SelectItem value="person">Each person</SelectItem>
              </SelectContent>
            </Select>

            <span className="text-muted-foreground">Counting</span>
            <Select value={counts} onValueChange={(v) => setCounts(v as RuleCounts)}>
              <SelectTrigger aria-label="Which cards count" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_COUNTS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {COUNTS[c][0]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label htmlFor="limit-name" className="text-muted-foreground">
              Name
            </label>
            <Input
              id="limit-name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional: “Roofing crew”, “Oven”"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {each && 'Each person is held to the number by the cards assigned to them; cards assigned to nobody aren’t counted. '}
            {COUNTS[counts][1]}
            {counts === countsFor(data.board.mode) && ' These are the cards this board’s lists show.'}
          </p>

          <div className="rounded-lg border">
            <button
              type="button"
              aria-expanded={which}
              onClick={() => setWhich(!which)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent/50"
            >
              Which cards
              <CaretDown className={cn('size-4 text-muted-foreground transition-transform', which && 'rotate-180')} />
            </button>
            {which && (
              <div className="border-t">
                <p className="px-4 pt-3 text-xs text-muted-foreground">
                  Tick the lists it is about (none: the whole board), and anything else its cards must be. A limit about one list shows on that list.
                </p>
                <FilterEditor rule value={cards} onChange={(next) => setCards(next as RuleFilter)} />
              </div>
            )}
          </div>

          <p className="rounded-md bg-muted px-3 py-2 text-sm">{valid ? describeRule(draft, data) : 'Type the number: how much there may be.'}</p>
        </form>

        <DialogFooter className="sm:justify-between">
          {rule ? (
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => void remove()}>
              Remove limit
            </Button>
          ) : (
            <span />
          )}
          <span className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="limit" disabled={!valid || busy}>
              {rule ? 'Save' : 'Set limit'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
