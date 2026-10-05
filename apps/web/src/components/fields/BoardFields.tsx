import { ArrowDown, ArrowUp, DotsThree, Eraser, MinusCircle, Plus } from '@phosphor-icons/react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { BoardFieldsView } from '@kanbanto/model/api'
import { FIELD_LIMITS, type BoardField, type FieldDef } from '@kanbanto/model/fields'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { hrefFor } from '@/app/router'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useLoaded } from '@/data/useLoaded'
import { FieldEditor } from './FieldEditor'
import { FIELD_ICON, fieldSummary } from './meta'

/**
 * Which fields this board uses (Board settings → Fields). Its owners pick them from the board's library (its
 * workspace's, or their own for a Personal board), put them in order, and choose up to three for the card front.
 * Taking one off keeps its values: they're back if it's added again. Anyone who can edit the board can clear a field
 * on all its cards. The fields themselves are made and changed in the library, by whoever manages it.
 */
export function BoardFields({ onLeave }: { onLeave: () => void }) {
  const { data, readOnly, run, reload } = useBoard()
  const boardId = data.board.id
  const [view, refetch] = useLoaded<BoardFieldsView>(useCallback(() => api('GET', `/boards/${encodeURIComponent(boardId)}/fields`), [boardId]))
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  if (!view) return null

  const { fields, canPick, canManage, workspace } = view
  const base = workspace ? `/workspaces/${workspace.id}/fields` : '/fields'
  const library = hrefFor(workspace ? { page: 'workspace', id: workspace.id, section: 'fields' } : { page: 'account', section: 'fields' })
  const list = fields.map((f) => ({ id: f.id, front: !!f.front }))
  const onFront = list.filter((f) => f.front).length

  const save = (next: { id: string; front?: boolean }[], done?: string) =>
    api('PUT', `/boards/${encodeURIComponent(boardId)}/fields`, { fields: next }).then(
      () => {
        if (done) toast(done)
        void refetch()
        reload()
      },
      (e) => void toast.error(errorMessage(e)),
    )
  const move = (i: number, by: -1 | 1) => {
    const next = [...list]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    void save(next)
  }
  const add = (f: Pick<FieldDef, 'id'>) => {
    setAdding(false)
    void save([...list, { id: f.id }])
  }
  const clear = (f: BoardField) =>
    setConfirm({
      title: `Clear “${f.name}” on every card?`,
      description: 'Every card on this board loses its value for it. Archived cards keep theirs. You can undo it right afterwards.',
      confirmLabel: 'Clear on all cards',
      destructive: true,
      // (Back to the board, where the result shows and its "Undo" can be reached: this dialog would be in the way.)
      onConfirm: () => {
        if (run({ type: 'tasks.clearField', fieldId: f.id })) onLeave()
      },
    })

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold">Fields</h2>
        <p className="text-xs text-muted-foreground">
          Extra things to fill in on every card of this board, like a client, an amount or a stage.{' '}
          {workspace ? `They come from ${workspace.name}’s fields.` : canPick ? 'They come from your own fields.' : ''}
        </p>
      </header>

      {fields.length > 0 ? (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {fields.map((f, i) => {
            const I = FIELD_ICON[f.type]
            return (
              <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <I className="size-4" />
                </span>
                {/* (Wide enough to read: on a narrow screen the controls go on a line of their own.) */}
                <div className="min-w-36 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{fieldSummary(f)}</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {canPick ? (
                    <label
                      className="mr-1 flex items-center gap-2 text-xs text-muted-foreground"
                      title={
                        !f.front && onFront >= FIELD_LIMITS.front
                          ? `Up to ${FIELD_LIMITS.front} fields show on cards`
                          : 'Show its value on the card, on the board'
                      }
                    >
                      On cards
                      <Switch
                        size="sm"
                        checked={!!f.front}
                        disabled={!f.front && onFront >= FIELD_LIMITS.front}
                        onCheckedChange={(on) => void save(list.map((x) => (x.id === f.id ? { ...x, front: on } : x)))}
                        aria-label={`Show ${f.name} on cards`}
                      />
                    </label>
                  ) : (
                    f.front && <span className="mr-1 text-xs text-muted-foreground">On cards</span>
                  )}
                  {canPick && (
                    <>
                      <Button variant="ghost" size="icon-xs" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon-xs" title="Move down" disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown />
                      </Button>
                    </>
                  )}
                  {!readOnly && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={`More for ${f.name}`}>
                          <DotsThree weight="bold" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => clear(f)}>
                          <Eraser /> Clear on all cards…
                        </DropdownMenuItem>
                        {canPick && (
                          <DropdownMenuItem
                            onSelect={() =>
                              void save(
                                list.filter((x) => x.id !== f.id),
                                `“${f.name}” is off this board. Its values are kept: add it again to bring them back.`,
                              )
                            }
                          >
                            <MinusCircle /> Take off this board
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {canPick ? 'This board has no fields of its own yet.' : 'This board has no fields of its own. Its owners choose them.'}
        </p>
      )}

      {canPick && (
        <div className="flex flex-wrap items-center gap-2">
          <Popover open={adding} onOpenChange={setAdding}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5" disabled={fields.length >= FIELD_LIMITS.perBoard}>
                <Plus /> Add a field
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              <ul className="max-h-72 overflow-y-auto">
                {view.available.map((f) => {
                  const I = FIELD_ICON[f.type]
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        onClick={() => add(f)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                      >
                        <I className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{f.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{fieldSummary(f)}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
                {!view.available.length && (
                  <li className="px-2 py-2 text-xs text-muted-foreground">
                    {canManage
                      ? 'Every field is already on this board. Make a new one below.'
                      : `Every field is already on this board. ${workspace?.name ?? 'The workspace'}’s admins add new ones.`}
                  </li>
                )}
              </ul>
              {canManage && (
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false)
                    setCreating(true)
                  }}
                  className="mt-1 flex w-full items-center gap-2.5 rounded-md border-t px-2 py-2 text-left text-sm font-medium text-primary hover:bg-accent"
                >
                  <Plus className="size-4" /> New field…
                </button>
              )}
            </PopoverContent>
          </Popover>
          <span className="text-xs text-muted-foreground">
            {fields.length} of {FIELD_LIMITS.perBoard}
          </span>
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        {canManage ? (
          <>
            To rename a field, change its options, or archive it for every board:{' '}
            <a href={library} onClick={onLeave} className="font-medium text-primary hover:underline">
              {workspace ? `${workspace.name}’s fields` : 'your fields'}
            </a>
            .
          </>
        ) : workspace ? (
          `Fields are added and changed by ${workspace.name}’s admins${canPick ? '' : '; this board’s owners choose which ones it uses'}.`
        ) : (
          'This board’s owners choose its fields.'
        )}
      </p>

      {creating && <FieldEditor base={base} onClose={() => setCreating(false)} onSaved={(_library, id) => add({ id })} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </section>
  )
}
