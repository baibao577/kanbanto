import { ArrowRight, Check, Eraser, Info, Tag, UserMinus, LinkBreak, ChatCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { BoardDot, StatusDot } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBoards } from '@/data/useBoards'
import { useWorkspaces } from '@/data/useWorkspaces'
import type { BoardSnapshot, BoardSummary } from '@kanbanto/model/api'
import { descendantsOf } from '@kanbanto/model/indexer'
import { planMove } from '@kanbanto/model/moveBoard'
import { EPOCH } from '@kanbanto/model/types'

const SAME = '__same'

/**
 * Moving a task (with its subtasks, comments and files) to another board you can edit. Shows what will happen before
 * it does: what comes along, and what doesn't fit on the other board.
 */
export function MoveToBoardDialog({ taskId, onClose, onMoved }: { taskId: string; onClose: () => void; onMoved: () => void }) {
  const { data, idx, counts } = useBoard()
  const { user } = useAuth()
  const { boards } = useBoards()
  const { workspaces } = useWorkspaces()
  const [to, setTo] = useState<BoardSummary | null>(null)
  const [target, setTarget] = useState<BoardSnapshot['data'] | null>(null)
  const [list, setList] = useState(SAME)
  const [busy, setBusy] = useState(false)
  const task = data.tasks[taskId]

  // Boards you can add to, grouped by where they live.
  const groups = useMemo(() => {
    const out = new Map<string, BoardSummary[]>()
    for (const b of boards ?? []) {
      if (b.id === data.board.id || b.role === 'viewer' || b.archivedAt) continue
      const place = b.workspaceId
        ? (workspaces?.find((w) => w.id === b.workspaceId)?.name ?? 'Workspace')
        : b.role === 'owner'
          ? 'Personal'
          : 'Shared with you'
      out.set(place, [...(out.get(place) ?? []), b])
    }
    return [...out]
  }, [boards, workspaces, data.board.id])

  useEffect(() => {
    if (!to) return
    let alive = true
    api<BoardSnapshot>('GET', `/boards/${to.id}`).then(
      (s) => alive && setTarget(s.data),
      (e) => alive && toast.error(errorMessage(e)),
    )
    return () => {
      alive = false
    }
  }, [to])

  // The same plan the server will make, to say what happens.
  const plan = useMemo(() => {
    if (!target || !task) return null
    let n = 0
    const r = planMove(data, target, taskId, { status: list === SAME ? undefined : list }, { now: EPOCH, newId: () => `p${n++}` })
    return 'error' in r ? null : r.summary
  }, [data, target, taskId, list, task])
  const moving = useMemo(() => (task ? [taskId, ...descendantsOf(idx, taskId)] : []), [idx, taskId, task])
  const comments = moving.reduce((s, id) => s + (counts.comments[id] ?? 0), 0)
  const files = moving.reduce((s, id) => s + (counts.attachments[id] ?? 0), 0)

  if (!task) return null

  const move = async () => {
    if (!to) return
    setBusy(true)
    try {
      const r = await api<{ id: string; board: { id: string; name: string } }>('POST', `/boards/${data.board.id}/tasks/${taskId}/move`, {
        boardId: to.id,
        ...(list !== SAME && { list }),
      })
      onMoved()
      toast(`Moved to “${r.board.name}”`, { action: { label: 'Open', onClick: () => navigate({ page: 'board', id: r.board.id, task: r.id }) } })
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const along = [
    moving.length > 1 && `${moving.length - 1} subtask${moving.length === 2 ? '' : 's'}`,
    comments > 0 && `${comments} comment${comments === 1 ? '' : 's'}`,
    files > 0 && `${files} file${files === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to another board</DialogTitle>
          <DialogDescription className="truncate">“{task.title}”</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">To</p>
          <Command className="rounded-lg border" shouldFilter>
            <CommandInput placeholder="Find a board" />
            <CommandList className="max-h-56">
              <CommandEmpty>{boards ? 'No other board you can add to.' : 'Loading…'}</CommandEmpty>
              {groups.map(([place, list]) => (
                <CommandGroup key={place} heading={place}>
                  {list.map((b) => (
                    <CommandItem
                      key={b.id}
                      value={`${b.name} ${b.id}`}
                      onSelect={() => {
                        setTo(b)
                        setTarget(null)
                        setList(SAME)
                      }}
                      className="gap-2.5"
                    >
                      <BoardDot background={b.background} />
                      <span className="truncate">{b.name}</span>
                      {b.id === user?.inboxBoardId && (
                        <span className="rounded bg-secondary px-1.5 text-[10px] font-medium text-muted-foreground">Inbox</span>
                      )}
                      {to?.id === b.id && <Check weight="bold" className="ml-auto text-primary" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>

        {to && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Into the list</p>
            <Select value={list} onValueChange={setList} disabled={!target}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SAME}>The same lists (matched by name)</SelectItem>
                {target?.columns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <StatusDot category={c.category} color={c.color} /> {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {to && plan && (
          <ul className="space-y-2 rounded-lg bg-muted/60 p-3 text-xs">
            <Note icon={<ArrowRight />}>
              {along.length ? <>Goes with it: {joinWords(along)}.</> : <>It moves on its own (no subtasks, comments or files).</>}
            </Note>
            {plan.unassigned.length > 0 && (
              <Note icon={<UserMinus />} warn>
                Not on “{to.name}”: {joinWords(plan.unassigned)}. Their tasks will have no one assigned.
              </Note>
            )}
            {plan.newLabels.length > 0 && (
              <Note icon={<Tag />}>
                Adds {plan.newLabels.length === 1 ? 'the label' : 'the labels'} {joinWords(plan.newLabels.map((l) => `“${l}”`))} to “{to.name}”.
              </Note>
            )}
            {plan.droppedFields.length > 0 && (
              <Note icon={<Eraser />} warn>
                “{to.name}” doesn’t use {joinWords(plan.droppedFields.map((f) => `“${f}”`))}:{' '}
                {plan.droppedFields.length === 1 ? 'that value' : 'those values'} won’t come along.
              </Note>
            )}
            {plan.droppedLinks > 0 && (
              <Note icon={<LinkBreak />} warn>
                {plan.droppedLinks === 1 ? 'A “waiting on” link' : `${plan.droppedLinks} “waiting on” links`} to tasks that stay here will be removed.
              </Note>
            )}
            {comments > 0 && <Note icon={<ChatCircle />}>People on “{to.name}” will see its comments.</Note>}
            <Note icon={<Info />}>It can’t be undone, but you can move it back.</Note>
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void move()} disabled={!to || !plan || busy}>
            {busy ? 'Moving…' : to ? `Move to “${to.name}”` : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Note({ icon, warn, children }: { icon: ReactNode; warn?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className={warn ? 'mt-px text-warning [&>svg]:size-3.5' : 'mt-px text-muted-foreground [&>svg]:size-3.5'}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}

const joinWords = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)
