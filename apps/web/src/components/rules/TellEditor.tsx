import { CaretDown } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import { newId } from '@kanbanto/model/ids'
import {
  ASSIGNEE,
  countsFor,
  describeRule,
  hasConditions,
  listOf,
  RULE_COUNTS,
  tellOn,
  toldBy,
  type RuleCounts,
  type RuleFilter,
  type WhenRule,
} from '@kanbanto/model/rules'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Avatar } from '@/components/common/bits'
import { FilterEditor } from '@/components/shell/FilterEditor'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { COUNTS, tidy } from './parts'

/**
 * Makes or changes a rule that tells people (the board's owners): when a card arrives in these cards, or leaves
 * them, tell these people. Who: anyone on the board, and whoever the card is assigned to. Under "Which cards" the
 * lists and the conditions, said with the Filter menu's own controls, as for a limit. Opened from a list's menu it
 * starts about that list; from the Rules page, about the whole board.
 *
 * Saved with its button, as a limit is: each save makes every open copy of the board read it again.
 */
export function TellEditor({
  rule,
  listId,
  onClose,
}: {
  /** The rule to change; left out: a new one. */
  rule?: WhenRule
  /** For a new one: the list it starts about. */
  listId?: string
  onClose: () => void
}) {
  const { data, reload } = useBoard()
  const [start] = useState<WhenRule>(
    () => rule ?? (listId ? tellOn(newId(), listId, data.board.mode) : { ...tellOn(newId(), '', data.board.mode), cards: {} }),
  )
  const [on, setOn] = useState(start.on)
  const [who, setWho] = useState<string[]>(() => toldBy(start))
  const [name, setName] = useState(start.name ?? '')
  const [counts, setCounts] = useState<RuleCounts>(start.counts)
  const [cards, setCards] = useState<RuleFilter>(start.cards)
  // "Which cards" is folded away while the rule is about one list and nothing more: the common case stays short.
  const [which, setWhich] = useState(!listOf(start) || hasConditions(start))
  const [busy, setBusy] = useState(false)
  // (Someone the rule names who has left the board is no longer told, and goes when it is saved.)
  const here = who.filter((id) => id === ASSIGNEE || data.members.some((m) => m.id === id))
  const valid = here.length > 0
  const { name: _name, ...kept } = start
  const draft: WhenRule = {
    ...kept,
    ...(name.trim() && { name: name.trim() }),
    on,
    cards: tidy(cards),
    counts,
    then: [{ do: 'tell', who: here }],
  }
  const one = listOf(draft)
  const list = one && data.columns.find((c) => c.id === one)?.name
  const address = `/boards/${data.board.id}/rules`
  const tick = (id: string) => setWho(who.includes(id) ? who.filter((w) => w !== id) : [...who, id])

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
      rule ? 'Rule changed' : 'Rule added',
    )
  const remove = () => send(() => api('DELETE', `${address}/${rule!.id}`), 'Rule removed')
  const person = 'flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-accent/50'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] flex-col gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{list ? `Tell people about “${list}”` : rule ? 'Rule' : 'New rule'}</DialogTitle>
          <DialogDescription>
            The people you tick get a line under their bell when it happens, whoever moved the card (never for what they do themselves). Each of them
            can switch it off for themselves.
          </DialogDescription>
        </DialogHeader>

        <form
          id="tell"
          className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && !busy) void save()
          }}
        >
          <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-sm">
            <span className="text-muted-foreground">When a card</span>
            <Select value={on} onValueChange={(v) => setOn(v as WhenRule['on'])}>
              <SelectTrigger id="tell-on" aria-label="When" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="enters">{list ? `Arrives in ${list}` : 'Arrives in these cards'}</SelectItem>
                <SelectItem value="leaves">{list ? `Leaves ${list}` : 'Leaves these cards'}</SelectItem>
              </SelectContent>
            </Select>

            <span className="self-start pt-1.5 text-muted-foreground">Tell</span>
            <div id="tell-who" role="group" aria-label="Who is told" className="max-h-52 overflow-y-auto rounded-lg border py-1">
              <label className={person}>
                <Checkbox checked={who.includes(ASSIGNEE)} onCheckedChange={() => tick(ASSIGNEE)} />
                Whoever it is assigned to
              </label>
              {data.members.map((m) => (
                <label key={m.id} className={person}>
                  <Checkbox checked={who.includes(m.id)} onCheckedChange={() => tick(m.id)} />
                  <Avatar name={m.name} picture={m.picture} className="size-5" />
                  <span className="truncate">{m.name}</span>
                </label>
              ))}
            </div>

            <label htmlFor="tell-name" className="text-muted-foreground">
              Name
            </label>
            <Input
              id="tell-name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional: “New quotes”, “Ready to bake”"
            />
          </div>

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
                  Tick the lists it is about (none: anywhere on the board), and anything else its cards must be. A card that is changed so that it
                  fits has arrived too: made Urgent, given the label.
                </p>
                <FilterEditor rule value={cards} onChange={(next) => setCards(next as RuleFilter)} />
                <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 border-t px-4 py-3 text-sm">
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
                  <p className="col-span-2 mt-2 text-xs text-muted-foreground">
                    {counts === 'leaves' && 'A card that has subtasks isn’t one of them: its subtasks are.'}
                    {counts === 'topLevel' && 'Subtasks aren’t: only the cards at the top.'}
                    {counts === 'all' && 'A card and each of its subtasks.'}
                    {counts === countsFor(data.board.mode) && ' These are the cards this board’s lists show.'}
                  </p>
                </div>
              </div>
            )}
          </div>

          <p className="rounded-md bg-muted px-3 py-2 text-sm">{valid ? describeRule(draft, data) : 'Tick who to tell.'}</p>
        </form>

        <DialogFooter className="sm:justify-between">
          {rule ? (
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => void remove()}>
              Remove rule
            </Button>
          ) : (
            <span />
          )}
          <span className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="tell" disabled={!valid || busy}>
              {rule ? 'Save' : 'Add rule'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
