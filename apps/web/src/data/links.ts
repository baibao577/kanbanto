import type { LinkedCard } from '@kanbanto/model/api'
import { parseRef } from '@kanbanto/model/fields'
import { indexFor, statusCol } from '@kanbanto/model/indexer'
import type { BoardData } from '@kanbanto/model/types'
import { api } from '@/api/client'

/** Links asked about in one request, and how long new ones are gathered before asking. */
const BATCH = 40
const WAIT_MS = 60

/**
 * What the links on one board's cards point at, as this person may see it (see LinkedCard). Chips read one link at
 * a time from here and are told when that one changes, so a title arriving redraws a chip and not the board.
 *
 * A card among the board's own active ones is read from the board, live. The rest (cards on other boards, archived
 * and deleted ones) come with the board and are added to as they're asked about: nothing is ever taken out, so a card
 * just picked keeps its title while the board is fetched again.
 *
 * The board's people are here too, by id, for the chips of person fields: the same idea (a chip hears about its own
 * person, and the board's list of people is a new one every time the board is fetched).
 */
export class LinkStore {
  readonly boardId: string
  private known = new Map<string, LinkedCard>()
  private local = new Map<string, LinkedCard>()
  private data: BoardData | null = null
  private listeners = new Map<string, Set<() => void>>()
  private all = new Set<() => void>()
  private people = new Map<string, string>()
  private faces = new Map<string, Set<() => void>>()
  private asked = new Set<string>()
  private queue = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Goes up with every change, for what reads many links at once (sorting by a link, a filter's words). */
  version = 0

  constructor(boardId: string) {
    this.boardId = boardId
  }

  /** What a link points at; undefined while it isn't known yet (it's asked for). */
  get = (ref: string): LinkedCard | undefined => this.local.get(ref) ?? this.here(ref) ?? this.known.get(ref)

  /** A linked card's title, for sorting and for saying a filter in words (undefined: not known, or not to be seen). */
  titleOf = (ref: string): string | undefined => {
    const card = this.get(ref)
    return card && 'title' in card ? card.title : undefined
  }

  getVersion = () => this.version

  /** The name of one of the board's people (undefined: they aren't on it, or not any more). */
  nameOf = (userId: string): string | undefined => this.people.get(userId)

  subscribePerson = (userId: string, listener: () => void) => {
    const set = this.faces.get(userId) ?? new Set()
    set.add(listener)
    this.faces.set(userId, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.faces.delete(userId)
    }
  }

  subscribe = (ref: string, listener: () => void) => {
    const set = this.listeners.get(ref) ?? new Set()
    set.add(listener)
    this.listeners.set(ref, set)
    if (this.get(ref) === undefined) this.want([ref])
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(ref)
    }
  }

  subscribeAll = (listener: () => void) => {
    this.all.add(listener)
    return () => void this.all.delete(listener)
  }

  /** The board as it is now: its own cards are read from it. Tells the chips whose card changed. */
  see(data: BoardData) {
    if (data === this.data) return
    const members = this.data?.members
    this.data = data
    const stale = [...this.local.keys()]
    this.local.clear()
    let changed = false
    if (data.members !== members) {
      const next = new Map(data.members.map((m) => [m.id, m.name]))
      for (const id of new Set([...next.keys(), ...this.people.keys()])) {
        if (next.get(id) === this.people.get(id)) continue
        changed = true
        if (next.has(id)) this.people.set(id, next.get(id)!)
        else this.people.delete(id)
        this.faces.get(id)?.forEach((l) => l())
      }
    }
    for (const ref of new Set([...stale, ...this.listeners.keys()])) {
      const before = stale.includes(ref)
      const now = this.here(ref)
      if (before || now) {
        changed = true
        this.listeners.get(ref)?.forEach((l) => l())
      }
    }
    if (changed) this.bump()
  }

  /** Cards learned from the server, or just picked. */
  learn(linked: Record<string, LinkedCard>) {
    let changed = false
    for (const [ref, card] of Object.entries(linked)) {
      if (JSON.stringify(this.known.get(ref)) === JSON.stringify(card)) continue
      this.known.set(ref, card)
      changed = true
      this.listeners.get(ref)?.forEach((l) => l())
    }
    if (changed) this.bump()
  }

  /** Asks the server about these links (once each, a few at a time). `again`: even ones already known, to refresh them. */
  want(refs: string[], again = false) {
    for (const ref of refs) {
      if (!parseRef(ref) || (!again && (this.asked.has(ref) || this.get(ref) !== undefined))) continue
      this.asked.add(ref)
      this.queue.add(ref)
    }
    if (this.queue.size && !this.timer) this.timer = setTimeout(() => void this.ask(), WAIT_MS)
  }

  private async ask() {
    this.timer = null
    const refs = [...this.queue].slice(0, BATCH)
    refs.forEach((r) => this.queue.delete(r))
    if (this.queue.size) this.timer = setTimeout(() => void this.ask(), WAIT_MS)
    try {
      const { linked } = await api<{ linked: Record<string, LinkedCard> }>(
        'GET',
        `/boards/${encodeURIComponent(this.boardId)}/linked?refs=${refs.map(encodeURIComponent).join(',')}`,
      )
      // (One the board doesn't hold any more isn't answered: it reads as a card that can't be opened.)
      this.learn({ ...Object.fromEntries(refs.map((r) => [r, { hidden: true } as LinkedCard])), ...linked })
    } catch {
      // Not reachable just now: they can be asked about again.
      refs.forEach((r) => this.asked.delete(r))
    }
  }

  /** A card of this board that's among its active ones, read from the board (and kept, so the same answer is the same object). */
  private here(ref: string): LinkedCard | undefined {
    const to = parseRef(ref)
    const data = this.data
    if (!to || !data || to.boardId !== this.boardId || !data.tasks[to.taskId]) return undefined
    const col = statusCol(indexFor(data), to.taskId)
    const card: LinkedCard = {
      title: data.tasks[to.taskId].title,
      board: { id: data.board.id, name: data.board.name },
      list: col.name,
      kind: col.category,
      done: col.category === 'done',
    }
    this.local.set(ref, card)
    return card
  }

  private bump() {
    this.version++
    this.all.forEach((l) => l())
  }
}
