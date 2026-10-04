import { CaretRight, Crosshair, Timer, X } from '@phosphor-icons/react'
import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CardsPage } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { navigate } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ancestorsOf } from '@kanbanto/model/indexer'
import { FilterChips } from './FilterChips'

const SlotContext = createContext<{ main: HTMLElement | null; lead: HTMLElement | null }>({ main: null, lead: null })

/**
 * Lets each view put its own controls (display, zoom…) on the right side of the view bar. `lead`: before the main
 * buttons (expand and collapse all).
 */
export function ViewActions({ children, lead }: { children: ReactNode; lead?: boolean }) {
  const slots = useContext(SlotContext)
  const slot = lead ? slots.lead : slots.main
  return slot ? createPortal(children, slot) : null
}

/** A small icon button for the view bar (expand or collapse all), named by its tooltip. */
export function BarIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The strip under the top bar: where you are on the left, the current view's controls on the right. It's frosted glass
 * over the view's background (`style`: the board's gradient), which runs on behind it.
 */
export function ViewBar({ children, search, style }: { children: ReactNode; search: string; style?: CSSProperties }) {
  const { logTime } = useBoard()
  const [main, setMain] = useState<HTMLElement | null>(null)
  const [lead, setLead] = useState<HTMLElement | null>(null)
  const slots = useMemo(() => ({ main, lead }), [main, lead])
  return (
    <SlotContext.Provider value={slots}>
      <div className="flex min-h-0 flex-1 flex-col" style={style}>
        <div className="relative z-10 flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-white/25 bg-background/35 px-3 py-1.5 shadow-[0_6px_16px_-12px_oklch(0_0_0/0.25)] backdrop-blur-md backdrop-saturate-[1.15] sm:px-4 dark:border-white/[0.06] dark:bg-background/40">
          <ScopeTrail search={search} />
          <FilterChips />
          {/*
           * On a phone the buttons wrap onto a second line rather than push the page sideways. Outlined buttons are
           * see-through here, like the bar they sit on, rather than solid white (`:where`: hover still wins).
           */}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 [&_:where(button[data-variant=outline])]:bg-background/40 [&_:where(button[data-variant=outline])]:shadow-none">
            {/* `contents`: both slots' buttons flow as one row, so they wrap together. */}
            <div ref={setLead} className="contents" />
            <div ref={setMain} className="contents" />
            {logTime && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8" onClick={() => logTime()} aria-label="Log time">
                    <Timer /> <span className="max-sm:hidden">Log time</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Log time on a card (L)</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        {children}
      </div>
    </SlotContext.Provider>
  )
}

/** How many of a board's archived cards match some words: asked a moment after the typing stops (0 until then). */
function useArchivedHits(boardId: string, q: string, skip: boolean): number {
  const [hits, setHits] = useState({ q: '', n: 0 })
  useEffect(() => {
    if (!q || skip) return
    let alive = true
    const timer = setTimeout(
      () =>
        api<CardsPage>('GET', `/cards?state=archived&board=${encodeURIComponent(boardId)}&q=${encodeURIComponent(q)}&limit=1`).then(
          (r) => alive && setHits({ q, n: r.total }),
          () => {},
        ),
      350,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [boardId, q, skip])
  return q && hits.q === q ? hits.n : 0
}

function ScopeTrail({ search }: { search: string }) {
  const { data, prefs, idx, focus, access } = useBoard()
  const focusId = prefs.focusId && prefs.focusId in data.tasks ? prefs.focusId : undefined
  // Searching also looks through archived cards, and says so (they're on the Cards page, not here).
  const archivedHits = useArchivedHits(data.board.id, search.trim(), access.via === 'public')

  if (!focusId)
    return (
      <p className="text-sm text-muted-foreground">
        {search.trim() ? (
          <>
            Searching for <span className="font-medium text-foreground">“{search.trim()}”</span>
            {archivedHits > 0 && (
              <>
                <span className="mx-1.5">·</span>
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => navigate({ page: 'cards', state: 'archived', board: data.board.id, q: search.trim() })}
                >
                  {archivedHits} archived {archivedHits === 1 ? 'card matches' : 'cards match'}
                </button>
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-foreground/80">
            {idx.preorder.length.toLocaleString()} {idx.preorder.length === 1 ? 'task' : 'tasks'}
          </span>
        )}
      </p>
    )

  const trail = ancestorsOf(data.tasks, focusId)
  return (
    <nav aria-label="Focus" className="flex min-w-0 items-center gap-1 text-sm">
      <Crosshair weight="bold" className="size-4 shrink-0 text-primary" />
      <button onClick={() => focus(undefined)} className="shrink-0 rounded px-1 text-muted-foreground hover:text-foreground">
        All projects
      </button>
      {trail.map((id) => (
        <span key={id} className="flex min-w-0 items-center gap-1">
          <CaretRight className="size-3 shrink-0 text-muted-foreground" />
          <button onClick={() => focus(id)} className="truncate rounded px-1 text-muted-foreground hover:text-foreground">
            {data.tasks[id].title}
          </button>
        </span>
      ))}
      <CaretRight className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate px-1 font-medium">{data.tasks[focusId].title}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => focus(undefined)}
        className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
        title="Stop focusing and show everything"
      >
        <X className="size-3" /> Show all
      </Button>
    </nav>
  )
}
