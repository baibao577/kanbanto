import { Archive, CaretDown, Check, DotsThree, Minus, Trash, UserCircle, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useBoard } from '@/app/board-context'
import { Avatar, LabelChip, PriorityIcon, StatusDot } from '@/components/common/bits'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { FieldValueEditor } from '@/components/fields/FieldValue'
import { DateField } from '@/components/task/pickers'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDay } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  cardsWord,
  common,
  commonValue,
  fieldOnCards,
  holdsSeveral,
  labelOnCards,
  labelShares,
  setOnCards,
  stillThere,
  theirSubtasks,
  type BulkChange,
} from '@kanbanto/model/bulk'
import { PRIORITIES, PRIORITY_LABEL } from '@kanbanto/model/types'
import type { Selection } from './useSelection'

/**
 * What can be done to the selected cards together: it floats at the foot of the view from the first tick to the
 * last. Every action is one change (see the model's bulk.ts), said with how many cards it changed and an Undo.
 * `shown`: the cards the view is showing now, to say how many of the selected ones aren't among them.
 */
export function SelectionBar({ selection, shown, className }: { selection: Selection; shown?: ReadonlySet<string>; className?: string }) {
  const { data, idx, run } = useBoard()
  const ids = useMemo(() => stillThere(idx, selection.ids), [idx, selection.ids])
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [fieldId, setFieldId] = useState<string | null>(null)
  const under = useMemo(() => theirSubtasks(idx, selection.ids), [idx, selection.ids])
  const labels = useMemo(() => labelShares(data, ids), [data, ids])
  // While the bar is up, the app's messages ("Assigned 3 cards · Undo") sit above it, not on it (see index.css).
  const some = ids.length > 0
  useEffect(() => {
    if (!some) return
    document.documentElement.dataset.selecting = ''
    return () => void delete document.documentElement.dataset.selecting
  }, [some])
  if (!some) return null

  const tasks = ids.map((id) => data.tasks[id])
  const hidden = shown ? ids.filter((id) => !shown.has(id)).length : 0
  const list = common(ids.map((id) => idx.status.get(id)))
  const person = common(tasks.map((t) => t.assigneeId))
  const priority = common(tasks.map((t) => t.priority))
  const field = data.fields.find((f) => f.id === fieldId)

  /** Does one change to the selected cards, and says what it came to. */
  const apply = (change: BulkChange, said: (cards: string) => string) => {
    const one = change.follow === 1
    const stay = change.follow ? `${cardsWord(change.follow)} ${one ? 'follows its' : 'follow their'} subtasks and ${one ? 'stays' : 'stay'}` : ''
    if (!change.command) return void toast(stay ? `Nothing moved: ${stay}.` : 'Nothing to change: they are like that already.', { id: 'refused' })
    run(change.command, said(cardsWord(change.changed)) + (stay ? `. ${stay[0].toUpperCase()}${stay.slice(1)}.` : ''))
  }
  const set = (fields: Parameters<typeof setOnCards>[3], said: (cards: string) => string) => apply(setOnCards(data, idx, ids, fields), said)
  const alsoUnder = under.length
    ? ` and ${under.length === 1 ? 'the subtask' : `the ${under.length.toLocaleString('en')} subtasks`} under ${ids.length === 1 ? 'it' : 'them'}`
    : ''

  return (
    <>
      <div className={cn('pointer-events-none absolute inset-x-2 bottom-4 z-30 flex justify-center', className)}>
        <div
          role="toolbar"
          aria-label="Change the selected cards"
          className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl bg-foreground p-1.5 text-background shadow-lg"
        >
          <span className="px-2 text-xs font-semibold whitespace-nowrap tabular-nums" aria-live="polite">
            {ids.length.toLocaleString()} selected
            {hidden > 0 && <span className="font-normal opacity-70"> · {hidden.toLocaleString()} not shown</span>}
          </span>
          {under.length > 0 && (
            <BarButton onClick={() => selection.add(under)} title="Select everything under the selected cards too">
              Add their {under.length === 1 ? 'subtask' : `${under.length.toLocaleString()} subtasks`}
            </BarButton>
          )}
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-background/25" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarButton menu>List</BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="w-56">
              {data.columns.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => set({ status: c.id }, (n) => `Moved ${n} to ${c.name}`)}>
                  <StatusDot category={c.category} color={c.color} /> <span className="truncate">{c.name}</span>
                  {list.value === c.id && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarButton menu>Assign</BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="max-h-80 w-56 overflow-y-auto">
              {data.members.map((m) => (
                <DropdownMenuItem key={m.id} onSelect={() => set({ assigneeId: m.id }, (n) => `Assigned ${n} to ${m.name}`)}>
                  <Avatar name={m.name} picture={m.picture} className="size-5 text-[9px]" /> <span className="truncate">{m.name}</span>
                  {person.value === m.id && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
              {data.members.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => set({ assigneeId: null }, (n) => `Unassigned ${n}`)} className="text-muted-foreground">
                <UserCircle /> No assignee
                {!person.mixed && !person.value && <Check className="ml-auto" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover>
            <PopoverTrigger asChild>
              <BarButton menu>Labels</BarButton>
            </PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-72 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Labels on {cardsWord(ids.length)}</p>
              {data.labels.length === 0 && (
                <p className="text-xs text-muted-foreground">This board has no labels yet. Make one from a card’s Labels.</p>
              )}
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {data.labels.map((l) => {
                  const s = labels.get(l.id) ?? { share: 'none' as const, cards: 0 }
                  const name = l.name ? `“${l.name}”` : 'the label'
                  return (
                    <li key={l.id}>
                      {/* A tick: every card has it. A dash: some do. A click gives it to all; from all, it takes it away. */}
                      <button
                        role="checkbox"
                        aria-checked={s.share === 'all' ? true : s.share === 'some' ? 'mixed' : false}
                        aria-label={l.name || l.color}
                        onClick={() =>
                          s.share === 'all'
                            ? apply(labelOnCards(data, idx, ids, l.id, false), (n) => `Removed ${name} from ${n}`)
                            : apply(labelOnCards(data, idx, ids, l.id, true), (n) => `Added ${name} to ${n}`)
                        }
                        className="flex w-full items-center gap-2 rounded-md p-1 text-left hover:bg-accent"
                      >
                        <span
                          className={cn(
                            'grid size-4 shrink-0 place-content-center rounded-[4px] border border-input shadow-xs',
                            s.share !== 'none' && 'border-primary bg-primary text-primary-foreground',
                          )}
                        >
                          {s.share === 'all' ? (
                            <Check className="size-3.5" />
                          ) : s.share === 'some' ? (
                            <Minus weight="bold" className="size-3" />
                          ) : null}
                        </span>
                        <LabelChip label={l} className="min-w-0" />
                        {s.share === 'some' && (
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {s.cards} of {ids.length}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarButton menu>Priority</BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="w-48">
              {PRIORITIES.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => set({ priority: p }, (n) => `Set ${n} to ${PRIORITY_LABEL[p].toLowerCase()} priority`)}>
                  <PriorityIcon priority={p} /> {PRIORITY_LABEL[p]}
                  {priority.value === p && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => set({ priority: null }, (n) => `Cleared the priority of ${n}`)} className="text-muted-foreground">
                No priority
                {!priority.mixed && !priority.value && <Check className="ml-auto" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover>
            <PopoverTrigger asChild>
              <BarButton menu>Dates</BarButton>
            </PopoverTrigger>
            <PopoverContent side="top" align="center" className="w-72 space-y-2 p-3">
              <p className="text-xs font-medium text-muted-foreground">Dates of {cardsWord(ids.length)}</p>
              {(['start', 'due'] as const).map((key) => {
                const now = common(tasks.map((t) => t[key]))
                const what = key === 'start' ? 'start' : 'due'
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 text-xs text-muted-foreground">{key === 'start' ? 'Start' : 'Due'}</span>
                    <div className="min-w-0 flex-1">
                      <DateField
                        value={now.value}
                        placeholder={now.mixed ? 'Different dates' : 'Add a date'}
                        onChange={(iso) =>
                          iso
                            ? set({ [key]: iso }, (n) => (key === 'start' ? `Set ${n} to start ${formatDay(iso)}` : `Set ${n} due ${formatDay(iso)}`))
                            : set({ [key]: '' }, (n) => `Cleared the ${what} date of ${n}`)
                        }
                      />
                    </div>
                    {now.mixed && (
                      <button
                        onClick={() => set({ [key]: '' }, (n) => `Cleared the ${what} date of ${n}`)}
                        className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )
              })}
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <BarButton menu aria-label="More to do with the selected cards">
                <span className="max-sm:hidden">More</span>
                <DotsThree weight="bold" className="size-4 sm:hidden" />
              </BarButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-60">
              {data.fields.length > 0 && (
                <>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Set a field…</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                      {data.fields.map((f) => (
                        <DropdownMenuItem key={f.id} onSelect={() => setFieldId(f.id)}>
                          <span className="truncate">{f.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={() => run({ type: 'tasks.archive', ids }, `Archived ${cardsWord(ids.length)}${alsoUnder}`)}>
                <Archive /> Archive
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  setConfirm({
                    title: `Delete ${cardsWord(ids.length)}?`,
                    description: `${ids.length === 1 ? `“${tasks[0].title}”` : `The ${ids.length.toLocaleString()} selected cards`}${alsoUnder} will be deleted, with their comments and files. You can undo it right after; later, it can’t be brought back. To put cards away and keep them, archive them.`,
                    confirmLabel: 'Delete',
                    destructive: true,
                    onConfirm: () => run({ type: 'tasks.delete', ids }, `Deleted ${cardsWord(ids.length)}${alsoUnder}`),
                  })
                }
                className="text-destructive focus:text-destructive"
              >
                <Trash /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <BarButton onClick={selection.clear} aria-label="Clear the selection" title="Clear the selection (Esc)">
            <X className="size-3.5" />
          </BarButton>
        </div>
      </div>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />

      {/* One of the board's own fields, set on all of them with the editor a card has for it. */}
      <Dialog open={!!field} onOpenChange={(o) => !o && setFieldId(null)}>
        {field && (
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {field.name} on {cardsWord(ids.length)}
              </DialogTitle>
              <FieldNote mixed={commonValue(data, ids, field).mixed} several={holdsSeveral(field)} />
            </DialogHeader>
            <div className="rounded-md border">
              <FieldValueEditor
                field={field}
                value={commonValue(data, ids, field).value}
                placeholder={commonValue(data, ids, field).mixed ? 'Different values' : undefined}
                onChange={(next) =>
                  apply(fieldOnCards(data, idx, ids, field, next, commonValue(data, ids, field).value), (n) =>
                    next === null ? `Cleared ${field.name} on ${n}` : `Set ${field.name} on ${n}`,
                  )
                }
              />
            </div>
            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => apply(fieldOnCards(data, idx, ids, field, null), (n) => `Cleared ${field.name} on ${n}`)}
              >
                Clear on all
              </Button>
              <Button size="sm" onClick={() => setFieldId(null)}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

/** What the editor of a field shows for several cards, said under its name. */
function FieldNote({ mixed, several }: { mixed: boolean; several: boolean }) {
  return (
    <DialogDescription>
      {several
        ? 'Shown: who or what every selected card has. What you add goes on all of them, what you remove comes off all of them, and the rest stays.'
        : mixed
          ? 'The selected cards differ. What you set here replaces it on all of them.'
          : 'What you set here is set on every selected card.'}
    </DialogDescription>
  )
}

function BarButton({ menu, className, children, ...props }: React.ComponentProps<'button'> & { menu?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium whitespace-nowrap outline-none hover:bg-background/15 focus-visible:ring-2 focus-visible:ring-background/60 data-[state=open]:bg-background/20',
        className,
      )}
      {...props}
    >
      {children}
      {menu && <CaretDown className="size-3 opacity-70" />}
    </button>
  )
}
