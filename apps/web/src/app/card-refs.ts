import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { BoardSummary, CardsPage } from '@kanbanto/model/api'
import { ancestorsOf } from '@kanbanto/model/indexer'
import { refOf } from '@kanbanto/model/refs'
import type { Task } from '@kanbanto/model/types'
import { matcher } from '@kanbanto/model/view'
import { api } from '@/api/client'
import { useBoard } from './board-context'
import { useAuth } from './use-auth'

// A card's name in text (WEB-12): which names are cards, where each leads, and the list a writer picks one from.
// Nothing is looked up to show a name: this board's cards are in memory, and for other boards knowing their letters
// is enough (the link names the board and the number; the card is found when someone follows it).

/** What text needs to turn the names in it into links (see RichText). */
export interface CardRefs {
  /** The letters that mean a board the reader can open (the ones it has, and had), to that board's id. */
  boards: ReadonlyMap<string, string>
  /** The board the text is on: its cards open in place. */
  here: string
  /** A card on that board, by its number. */
  card: (n: number) => { id: string; title: string } | undefined
  open: (taskId: string) => void
}

/** A card to pick, to mention it. */
export interface CardPick {
  ref: string
  title: string
  /** Where it is: its parents on this board, or its board's name. */
  where: string
}
/** Where the "/" menu's Card finds cards: this board's at once, and (signed in) other boards' from the server. */
export interface CardSource {
  here: (q: string) => CardPick[]
  elsewhere?: (q: string) => Promise<CardPick[]>
}

const NONE: ReadonlyMap<string, string> = new Map()
const FRESH = 60_000
let known: { at: number; codes: ReadonlyMap<string, string> } | null = null
let asking = false
const watchers = new Set<() => void>()

/** The boards' letters, most recently active board first: when two boards have the same, that one is meant. */
function lettersOf(boards: BoardSummary[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const b of boards) if (b.code && !out.has(b.code)) out.set(b.code, b.id)
  for (const b of boards) for (const c of b.pastCodes ?? []) if (!out.has(c)) out.set(c, b.id)
  return out
}

function refresh() {
  if (asking || (known && Date.now() - known.at < FRESH)) return
  asking = true
  api<{ boards: BoardSummary[] }>('GET', '/boards')
    .then(
      (r) => {
        known = { at: Date.now(), codes: lettersOf(r.boards) }
        for (const w of watchers) w()
      },
      // (Not reachable just now: names of other boards' cards stay plain text until it is.)
      () => {},
    )
    .finally(() => (asking = false))
}

/** The letters of every board the person can open: asked once and shared by everything on the page, a minute at a time. */
function useBoardLetters(on: boolean): ReadonlyMap<string, string> {
  const codes = useSyncExternalStore(
    (w) => {
      watchers.add(w)
      return () => watchers.delete(w)
    },
    () => known?.codes ?? NONE,
  )
  useEffect(() => {
    if (on) refresh()
  })
  return on ? codes : NONE
}

/** For showing text on this board's cards: the names in it that are cards. Nothing when the board has no letters yet. */
export function useCardRefs(): CardRefs | undefined {
  const { data, openTask } = useBoard()
  // (A visitor with the public link can open this board alone.)
  const others = useBoardLetters(!!useAuth().user)
  const { board, tasks } = data
  return useMemo(() => {
    const boards = new Map<string, string>()
    for (const c of [board.code, ...(board.pastCodes ?? [])]) if (c) boards.set(c, board.id)
    for (const [c, id] of others) if (!boards.has(c)) boards.set(c, id)
    if (!boards.size) return undefined
    let byNumber: Map<number, Task> | null = null
    const card = (n: number) => {
      byNumber ??= new Map(Object.values(tasks).flatMap((t) => (t.number ? [[t.number, t] as const] : [])))
      return byNumber.get(n)
    }
    return { boards, here: board.id, card, open: openTask }
  }, [board, tasks, others, openTask])
}

const SHOWN = 8

/** For writing on this board's cards: the cards "/" → Card offers. Nothing when the board has no letters yet. */
export function useCardSource(): CardSource | undefined {
  const { data, idx } = useBoard()
  const signedIn = !!useAuth().user
  return useMemo(() => {
    const { board } = data
    if (!board.code) return undefined
    const pick = (t: Task): CardPick => ({
      ref: refOf(board, t)!,
      title: t.title,
      where: ancestorsOf(idx.tasks, t.id)
        .map((a) => idx.tasks[a].title)
        .join(' › '),
    })
    return {
      here: (q) => {
        const match = matcher(q, undefined, idx.codes)
        const found: Task[] = []
        // With nothing typed: the cards last worked on. Otherwise as the outline has them.
        const ids = match ? idx.preorder : [...idx.preorder].sort((a, b) => (idx.lastActive.get(b) ?? 0) - (idx.lastActive.get(a) ?? 0))
        for (const id of ids) {
          const t = idx.tasks[id]
          if (!t.number || (match && !match(t))) continue
          found.push(t)
          if (found.length >= SHOWN) break
        }
        return found.map(pick)
      },
      ...(signedIn && {
        elsewhere: async (q: string) => {
          const page = await api<CardsPage>('GET', `/cards?state=active&in=titles&limit=${SHOWN}&q=${encodeURIComponent(q)}`)
          return page.cards.flatMap((c) => (c.ref && c.board.id !== board.id ? [{ ref: c.ref, title: c.title, where: c.board.name }] : []))
        },
      }),
    }
  }, [data, idx, signedIn])
}
