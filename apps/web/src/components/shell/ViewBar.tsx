import { CaretRight, Crosshair, X } from '@phosphor-icons/react'
import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useBoard } from '@/app/board-context'
import { navigate } from '@/app/router'
import { Button } from '@/components/ui/button'
import { ancestorsOf } from '@kanbanto/model/indexer'
import { FilterChips } from './FilterChips'

const SlotContext = createContext<HTMLElement | null>(null)

/** Lets each view put its own controls (display, zoom…) on the right side of the view bar. */
export function ViewActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext)
  return slot ? createPortal(children, slot) : null
}

/**
 * The strip under the top bar: where you are on the left, the current view's controls on the right. It's frosted glass
 * over the view's background (`style`: the board's gradient), which runs on behind it.
 */
export function ViewBar({ children, search, style }: { children: ReactNode; search: string; style?: CSSProperties }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <SlotContext.Provider value={slot}>
      <div className="flex min-h-0 flex-1 flex-col" style={style}>
        <div className="relative z-10 flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-white/25 bg-background/35 px-3 py-1.5 shadow-[0_6px_16px_-12px_oklch(0_0_0/0.25)] backdrop-blur-md backdrop-saturate-[1.15] sm:px-4 dark:border-white/[0.06] dark:bg-background/40">
          <ScopeTrail search={search} />
          <FilterChips />
          <div ref={setSlot} className="ml-auto flex items-center gap-1.5" />
        </div>
        {children}
      </div>
    </SlotContext.Provider>
  )
}

function ScopeTrail({ search }: { search: string }) {
  const { data, prefs, idx, focus } = useBoard()
  const focusId = prefs.focusId && prefs.focusId in data.tasks ? prefs.focusId : undefined
  // Searching also looks through archived cards, and says so (they're on the Cards page).
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const archivedHits = words.length
    ? Object.values(data.archived ?? {}).filter((t) => words.every((w) => `${t.title} ${t.description ?? ''}`.toLowerCase().includes(w))).length
    : 0

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
          <>
            <span className="font-medium text-foreground">All projects</span>
            <span className="mx-1.5">·</span>
            {idx.preorder.length.toLocaleString()} {idx.preorder.length === 1 ? 'task' : 'tasks'}
          </>
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
