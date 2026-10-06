import { ArrowLeft, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { CardRow, CardsPage } from '@kanbanto/model/api'
import type { FieldDef } from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { CARD_SORTS, CARD_SORT_LABEL, periodOf, type CardSort } from '@kanbanto/model/search'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate, type CardsRoute } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { LogoMark } from '@/components/common/Logo'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useBoards } from '@/data/useBoards'
import { useWorkspaces } from '@/data/useWorkspaces'
import { zone } from '@/components/time/logging'
import { useNow } from '@/lib/useNow'
import { CardPeek } from './CardPeek'
import { CardRowItem } from './CardRowItem'
import { CardsFilters } from './CardsFilters'
import { cardsQuery, isFiltered, QUICK, quickOf, type Search } from './search'

/**
 * Search cards: every card on the boards you can open, as one list, to look back ("what did I finish this week?",
 * "what was going on in July?") or find one again, archived or not. Words match titles, descriptions and comments.
 * The address holds the whole search, so one can be kept or shared. It's for looking: a card opens view only, with a
 * way to its board (archived ones can be restored or deleted from the list).
 */
export function CardsView({ route }: { route: CardsRoute }) {
  const { user } = useAuth()
  const { boards } = useBoards()
  const { workspaces } = useWorkspaces()
  const [page, setPage] = useState<CardsPage | null>(null)
  const [more, setMore] = useState<CardRow[]>([])
  // Every field seen so far: the one picked keeps its name and options when the boards searched no longer have it.
  const [knownFields, setKnownFields] = useState<Record<string, FieldDef>>({})
  const [words, setWords] = useState(route.q ?? '')
  const [reload, setReload] = useState(0)
  // The card open in place (its board is loaded while it's open).
  const [peek, setPeek] = useState<CardRow | null>(null)
  const now = useNow()
  const board = boards?.find((b) => b.id === route.board)
  const set = (patch: Partial<Search>) => navigate({ ...route, ...patch }, { replace: true })

  useEffect(() => {
    document.title = 'Search cards · Kanbanto'
  }, [])

  // Typing updates the address (and the list) after a short pause.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((route.q ?? '') !== words.trim()) navigate({ ...route, q: words.trim() || undefined }, { replace: true })
    }, 250)
    return () => clearTimeout(t)
  }, [words, route])

  const query = cardsQuery(route, { zone: zone() })
  useEffect(() => {
    let alive = true
    api<CardsPage>('GET', `/cards?${query}`).then(
      (r) => {
        if (!alive) return
        setPage(r)
        setMore([])
        if (r.fields?.length) setKnownFields((known) => ({ ...known, ...Object.fromEntries(r.fields!.map((f) => [f.id, f])) }))
      },
      (e) => alive && toast.error(errorMessage(e)),
    )
    return () => {
      alive = false
    }
  }, [query, reload])

  const loadMore = async () => {
    if (!page) return
    try {
      const r = await api<CardsPage>('GET', `/cards?${cardsQuery(route, { offset: page.cards.length + more.length, zone: zone() })}`)
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

  // Sorted by a date, the list reads as a look back: today, yesterday, this week, then month by month.
  const sort = route.sort ?? 'recent'
  const groups = useMemo(() => {
    const rows = [...(page?.cards ?? []), ...more]
    const dated = sort === 'recent' || sort === 'created'
    const out: { title: string | null; cards: CardRow[] }[] = []
    for (const c of rows) {
      const title = dated ? periodOf(Date.parse(sort === 'created' ? c.createdAt : c.at), new Date(now)) : null
      if (out.at(-1)?.title === title && out.length) out.at(-1)!.cards.push(c)
      else out.push({ title, cards: [c] })
    }
    return out
  }, [page, more, sort, now])
  const shown = (page?.cards.length ?? 0) + more.length
  const quick = quickOf(route)
  const narrowed = isFiltered(route) || !!route.q
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
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <MagnifyingGlass className="size-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold">Search cards</h1>
              <p className="text-xs text-muted-foreground">
                Every card on the boards you can open. Opening one shows it as it is; change it on its board.
              </p>
            </div>
          </div>

          <label className="relative block">
            <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={words}
              onChange={(e) => setWords(e.target.value)}
              // On a computer you came here to type; on a phone that would bring the keyboard up over the list.
              autoFocus={typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches}
              placeholder="Words in a title, description or comment"
              aria-label="Search cards"
              className="h-10 w-full rounded-md border bg-background pr-9 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            {words && (
              <button
                type="button"
                aria-label="Clear the words"
                onClick={() => setWords('')}
                className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick searches">
            {QUICK.map((x) => (
              <button
                key={x.id}
                type="button"
                title={x.hint}
                aria-pressed={quick === x.id}
                // Choosing one replaces the filters; choosing it again clears them. Where you look and the words stay.
                onClick={() =>
                  navigate(
                    { page: 'cards', board: route.board, place: route.place, q: route.q, ...(quick === x.id ? { state: 'active' } : x.search) },
                    { replace: true },
                  )
                }
                className={`h-7 rounded-full border px-3 text-xs font-medium ${
                  quick === x.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-foreground/80 hover:bg-accent'
                }`}
              >
                {x.label}
              </button>
            ))}
          </div>

          <CardsFilters
            search={route}
            set={set}
            boards={boards ?? []}
            workspaces={workspaces ?? []}
            people={page?.people ?? []}
            labels={page?.labels ?? []}
            fields={page?.fields ?? []}
            field={route.field ? knownFields[route.field] : undefined}
            meId={user?.id ?? ''}
          />

          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
            {page && (
              <span className="tabular-nums">
                {page.total.toLocaleString()} {page.total === 1 ? 'card' : 'cards'}
              </span>
            )}
            {narrowed && (
              <button
                type="button"
                className="hover:text-foreground hover:underline"
                onClick={() => {
                  setWords('')
                  navigate({ page: 'cards', state: 'active', board: route.board, place: route.place }, { replace: true })
                }}
              >
                Clear search
              </button>
            )}
            <Select value={sort} onValueChange={(v) => set({ sort: v === 'recent' ? undefined : (v as CardSort) })}>
              <SelectTrigger size="sm" className="ml-auto h-7 border-none px-2 text-xs shadow-none" aria-label="Order">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {CARD_SORTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {CARD_SORT_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {page && !shown ? (
            <div className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
              {narrowed
                ? route.state === 'archived' && !route.q && quick === 'archived'
                  ? 'No archived cards. Archive a card from its ⋯ menu when it’s done or on hold.'
                  : route.state === 'active'
                    ? 'No cards match. Archived cards are left out: include them under More.'
                    : 'No cards match.'
                : 'No cards yet.'}
            </div>
          ) : (
            groups.map((g, i) => (
              <section key={g.title ?? i} aria-label={g.title ?? undefined}>
                {g.title && <h2 className="mb-1.5 px-1 text-xs font-semibold text-muted-foreground">{g.title}</h2>}
                <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                  {g.cards.map((c) => (
                    <CardRowItem
                      key={`${c.board.id}:${c.id}`}
                      card={c}
                      showBoard={!route.board}
                      now={now}
                      onOpen={() => setPeek(c)}
                      onRestore={() => void act(c, 'task.restore')}
                      onDelete={() => void act(c, 'task.delete')}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
          {peek && <CardPeek key={`${peek.board.id}:${peek.id}`} boardId={peek.board.id} taskId={peek.id} viewOnly onClose={() => setPeek(null)} />}
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
