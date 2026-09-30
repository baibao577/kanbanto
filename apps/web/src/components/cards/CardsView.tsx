import { Archive, ArrowCounterClockwise, ArrowLeft, CheckCircle, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { CardRow, CardsPage } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate, type CardsRoute } from '@/app/router'
import { BoardDot } from '@/components/common/bits'
import { LogoMark } from '@/components/common/Logo'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CardPeek } from './CardPeek'
import { useBoards } from '@/data/useBoards'

const ALL = '__all'

/**
 * Cards across boards, as one searchable list. Today it's the archived ones: look back, open one (read-only),
 * restore it or delete it for good. The address holds the filters (board, words), so it can be linked to and
 * later grow into every card, with more filters, without becoming a different page.
 */
export function CardsView({ route }: { route: CardsRoute }) {
  const { boards } = useBoards()
  const [page, setPage] = useState<CardsPage | null>(null)
  const [more, setMore] = useState<CardRow[]>([])
  const [words, setWords] = useState(route.q ?? '')
  const [reload, setReload] = useState(0)
  // The card open in place (its board is loaded while it's open).
  const [peek, setPeek] = useState<CardRow | null>(null)
  const board = boards?.find((b) => b.id === route.board)

  useEffect(() => {
    document.title = 'Archived cards · Kanbanto'
  }, [])

  // Typing updates the address (and the list) after a short pause.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((route.q ?? '') !== words.trim()) navigate({ ...route, q: words.trim() || undefined }, { replace: true })
    }, 250)
    return () => clearTimeout(t)
  }, [words, route])

  useEffect(() => {
    let alive = true
    const p = new URLSearchParams({ state: route.state })
    if (route.board) p.set('board', route.board)
    if (route.q) p.set('q', route.q)
    if (route.completed !== undefined) p.set('completed', String(route.completed))
    api<CardsPage>('GET', `/cards?${p}`).then(
      (r) => {
        if (!alive) return
        setPage(r)
        setMore([])
      },
      (e) => alive && toast.error(errorMessage(e)),
    )
    return () => {
      alive = false
    }
  }, [route.state, route.board, route.q, route.completed, reload])

  const loadMore = async () => {
    if (!page) return
    const p = new URLSearchParams({ state: route.state, offset: String(page.cards.length + more.length) })
    if (route.board) p.set('board', route.board)
    if (route.q) p.set('q', route.q)
    if (route.completed !== undefined) p.set('completed', String(route.completed))
    try {
      const r = await api<CardsPage>('GET', `/cards?${p}`)
      setMore((m) => [...m, ...r.cards])
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const act = async (c: CardRow, type: 'task.restore' | 'task.delete') => {
    if (type === 'task.delete' && !confirm(`Delete “${c.title}”${c.subtasks ? ' and its subtasks' : ''} for good? This can’t be undone.`)) return
    try {
      await api('POST', `/boards/${c.board.id}/mutations`, { mutationId: newId(), command: { type, id: c.id } })
      toast(type === 'task.restore' ? `Restored “${c.title}” to “${c.board.name}”` : `Deleted “${c.title}”`, {
        ...(type === 'task.restore' && { action: { label: 'Open', onClick: () => navigate({ page: 'board', id: c.board.id, task: c.id }) } }),
      })
      setReload((n) => n + 1)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const rows = [...(page?.cards ?? []), ...more]
  const shown = rows.length
  const back = board ? { href: hrefFor({ page: 'board', id: board.id }), label: board.name } : { href: hrefFor({ page: 'home' }), label: 'Boards' }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <a href={hrefFor({ page: 'home' })} className="grid size-8 place-items-center rounded-md hover:bg-accent" aria-label="Your boards">
          <LogoMark className="size-7" title="Your boards" />
        </a>
        <a href={back.href} className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5 shrink-0" /> <span className="truncate">{back.label}</span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <AccountMenu />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Archive className="size-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold">Archived cards</h1>
              <p className="text-xs text-muted-foreground">Put away, not deleted: open one to look back, or restore it to its board.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={route.board ?? ALL} onValueChange={(v) => navigate({ ...route, board: v === ALL ? undefined : v }, { replace: true })}>
              <SelectTrigger className="w-56" aria-label="Board">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All boards</SelectItem>
                {(boards ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    <BoardDot background={b.background} /> {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToggleGroup
              type="single"
              variant="outline"
              value={route.completed === undefined ? 'all' : route.completed ? 'yes' : 'no'}
              onValueChange={(v) => v && navigate({ ...route, completed: v === 'all' ? undefined : v === 'yes' }, { replace: true })}
              aria-label="Completed or not"
            >
              <ToggleGroupItem value="all" className="px-3 text-xs">
                All
              </ToggleGroupItem>
              <ToggleGroupItem value="yes" className="px-3 text-xs">
                Completed
              </ToggleGroupItem>
              <ToggleGroupItem value="no" className="px-3 text-xs">
                Not completed
              </ToggleGroupItem>
            </ToggleGroup>
            <label className="relative min-w-48 flex-1">
              <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={words}
                onChange={(e) => setWords(e.target.value)}
                placeholder="Search archived cards"
                aria-label="Search archived cards"
                className="h-9 w-full rounded-md border bg-background pr-3 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              />
            </label>
            {page && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {page.total.toLocaleString()} {page.total === 1 ? 'card' : 'cards'}
              </span>
            )}
          </div>

          {page && !rows.length ? (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
              {route.q || route.completed !== undefined
                ? 'No archived cards match.'
                : 'No archived cards. Archive a card from its ⋯ menu when it’s done or on hold.'}
            </div>
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border bg-card">
              {rows.map((c) => (
                <li key={`${c.board.id}:${c.id}`} className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => setPeek(c)} className="group min-w-0 flex-1 text-left">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {!route.board && (
                        <>
                          <BoardDot background={c.board.background} />
                          <span className="truncate">{c.board.name}</span>
                          {c.path.length > 0 && <span>›</span>}
                        </>
                      )}
                      <span className="truncate">{c.path.join(' › ')}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium group-hover:underline">{c.title}</span>
                      {c.completed && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-status-done/12 px-1.5 py-0.5 text-[11px] font-medium text-status-done">
                          <CheckCircle weight="fill" className="size-3" /> Completed
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {[c.list && `from ${c.list}`, c.assignee, c.subtasks > 0 && `${c.subtasks} subtask${c.subtasks === 1 ? '' : 's'}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline" title={c.archivedAt ?? undefined}>
                    {c.archivedAt && `archived ${formatDistanceToNow(parseISO(c.archivedAt), { addSuffix: true })}`}
                  </span>
                  {c.canEdit && (
                    <>
                      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void act(c, 'task.restore')}>
                        <ArrowCounterClockwise /> Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete ${c.title} for good`}
                        onClick={() => void act(c, 'task.delete')}
                      >
                        <Trash />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {peek && (
            <CardPeek
              key={`${peek.board.id}:${peek.id}`}
              boardId={peek.board.id}
              taskId={peek.id}
              onClose={() => {
                setPeek(null)
                setReload((n) => n + 1)
              }}
            />
          )}
          {page && page.total > shown && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => void loadMore()}>
                Show more ({(page.total - shown).toLocaleString()})
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
