import type { Command, TaskFields } from './commands'
import { sameValue, type BoardField, type FieldValue } from './fields'
import { descendantsOf, indexFor, type TaskIndex } from './indexer'
import type { BoardData, Task } from './types'
import { byHand } from './view'

// Changing several cards at once, from a selection: which cards a change reaches, and the one command it comes to
// (`tasks.update`, `tasks.archive`, `tasks.delete`), so it is one change with one undo. Worked out from the board
// as it is, here, so every view that lets cards be selected says and does the same.

/** The cards of a selection that are still on the board, in the outline's order. */
export const stillThere = (idx: TaskIndex, ids: ReadonlySet<string>): string[] => idx.preorder.filter((id) => ids.has(id))

/** The subtasks, at any depth, of the selected cards that aren't selected themselves ("Add their 5 subtasks"). */
export function theirSubtasks(idx: TaskIndex, ids: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const id of ids) if (id in idx.tasks) for (const k of descendantsOf(idx, id)) if (!ids.has(k)) out.add(k)
  return [...out]
}

/**
 * What archiving or deleting a selection takes: the selected cards (`cards`), and the subtasks that go with them
 * without having been selected (`along`), since a card is never put away without what is under it.
 */
export function withWhatIsUnder(idx: TaskIndex, ids: ReadonlySet<string>): { cards: number; along: number } {
  return { cards: stillThere(idx, ids).length, along: theirSubtasks(idx, ids).length }
}

/** How much of a selection has something: every card, some of them, none. */
export type Share = 'all' | 'some' | 'none'
const shareOf = (n: number, of: number): Share => (n === 0 ? 'none' : n === of ? 'all' : 'some')

/** Each of the board's labels, by how many of these cards have it. */
export function labelShares(data: BoardData, ids: readonly string[]): Map<string, { share: Share; cards: number }> {
  const out = new Map<string, { share: Share; cards: number }>()
  for (const l of data.labels) {
    const n = ids.filter((id) => data.tasks[id]?.labels.includes(l.id)).length
    out.set(l.id, { share: shareOf(n, ids.length), cards: n })
  }
  return out
}

/**
 * What these cards have in common for one part of a card: the value they all have, or `mixed` when they differ
 * (`undefined` with `mixed` false: none of them has one).
 */
export function common<T>(
  values: readonly (T | undefined)[],
  same: (a: T | undefined, b: T | undefined) => boolean = Object.is,
): { value?: T; mixed: boolean } {
  if (!values.length) return { mixed: false }
  return values.every((v) => same(v, values[0])) ? { value: values[0], mixed: false } : { mixed: true }
}

/** A field that holds a list one adds to and takes from: several people, several linked cards. */
export const holdsSeveral = (f: Pick<BoardField, 'type' | 'many'>) => !!f.many && (f.type === 'person' || f.type === 'link')

/**
 * What these cards hold for one of the board's fields, to show in its editor: the value they all have. For a field
 * that holds several (people, linked cards) it is the ones every card has: adding to that list adds to every card,
 * taking from it takes from every card, and what only some cards have is left alone.
 */
export function commonValue(data: BoardData, ids: readonly string[], field: BoardField): { value?: FieldValue; mixed: boolean } {
  const values = ids.map((id) => data.tasks[id]?.custom?.[field.id])
  if (!holdsSeveral(field)) return common(values, sameValue)
  const lists = values.map((v) => (Array.isArray(v) ? v : []))
  const inAll = (lists[0] ?? []).filter((x) => lists.every((l) => l.includes(x)))
  return { value: inAll.length ? inAll : undefined, mixed: lists.some((l) => l.length !== inAll.length) }
}

/** One change to several cards: the command (none when nothing would change), how many cards it changes, how many stay as they are because they can't take it. */
export interface BulkChange {
  command?: Command
  changed: number
  /** Cards whose list follows their subtasks: a move to a list leaves them where they are. */
  follow: number
}

const none: BulkChange = { changed: 0, follow: 0 }

/** Whether a card would be any different with these fields. */
function differs(t: Task, f: TaskFields): boolean {
  if (f.status !== undefined && f.status !== t.status) return true
  if (f.assigneeId !== undefined && (f.assigneeId ?? undefined) !== t.assigneeId) return true
  if (f.priority !== undefined && (f.priority ?? undefined) !== t.priority) return true
  if (f.due !== undefined && (f.due || undefined) !== t.due) return true
  if (f.start !== undefined && (f.start || undefined) !== t.start) return true
  if (f.labels && f.labels.join() !== t.labels.join()) return true
  for (const [k, v] of Object.entries(f.custom ?? {})) if (!sameValue(t.custom?.[k], v ?? undefined)) return true
  return false
}

/** The same fields on every one of these cards, or each card's own (`each`). */
function update(data: BoardData, idx: TaskIndex, ids: readonly string[], each: (t: Task) => TaskFields | undefined): BulkChange {
  // Parents asked into a list they aren't in, where a parent's list follows its subtasks: each with the list asked.
  const parents: [id: string, status: string][] = []
  const cards: { id: string; fields: TaskFields }[] = []
  for (const id of ids) {
    const t = data.tasks[id]
    let fields = t && each(t)
    if (!t || !fields) continue
    // Where parents follow their subtasks, a parent has no list of its own to set.
    if (fields.status !== undefined && data.board.mode === 'derived' && idx.childrenOf.get(id)?.length) {
      const { status: its, ...rest } = fields
      if (idx.status.get(id) !== its) parents.push([id, its])
      fields = rest
    }
    if (differs(t, fields)) cards.push({ id, fields })
  }
  if (!cards.length) return { ...none, follow: parents.length }
  // A parent goes where its subtasks go: the ones that stay are those still in another list once the cards moved.
  let follow = 0
  if (parents.length) {
    const moved = new Map(cards.flatMap((c) => (c.fields.status ? [[c.id, c.fields.status] as const] : [])))
    const tasks = Object.fromEntries(Object.entries(data.tasks).map(([id, t]) => [id, moved.has(id) ? { ...t, status: moved.get(id)! } : t]))
    const after = moved.size ? indexFor({ ...data, tasks }) : idx
    follow = parents.filter(([id, status]) => after.status.get(id) !== status).length
  }
  // The lists cards move into, each in its new order: the cards that are there, then the ones arriving.
  const into = new Map<string, string[]>()
  for (const c of cards) if (c.fields.status) into.set(c.fields.status, [...(into.get(c.fields.status) ?? []), c.id])
  const lists = [...into].map(([status, moved]) => {
    const arriving = new Set(moved)
    return {
      status,
      order: [
        ...byHand(
          idx,
          idx.preorder.filter((id) => idx.status.get(id) === status && !arriving.has(id)),
        ),
        ...moved,
      ],
    }
  })
  return { command: { type: 'tasks.update', cards, ...(lists.length && { lists }) }, changed: cards.length, follow }
}

/** Sets these fields on every one of these cards (a list, a person, a priority, dates): the cards that would change. */
export const setOnCards = (data: BoardData, idx: TaskIndex, ids: readonly string[], fields: TaskFields): BulkChange =>
  update(data, idx, ids, () => fields)

/** Gives a label to every one of these cards, or takes it from them. The labels a card has besides stay. */
export const labelOnCards = (data: BoardData, idx: TaskIndex, ids: readonly string[], labelId: string, on: boolean): BulkChange =>
  update(data, idx, ids, (t) =>
    t.labels.includes(labelId) === on ? undefined : { labels: on ? [...t.labels, labelId] : t.labels.filter((l) => l !== labelId) },
  )

/**
 * Sets one of the board's fields on these cards, from its editor: `next` is what the editor now holds (null:
 * cleared), `shown` what it showed (see `commonValue`). A field that holds several gets what was added and loses
 * what was taken away, card by card; any other field gets the value.
 */
export function fieldOnCards(
  data: BoardData,
  idx: TaskIndex,
  ids: readonly string[],
  field: BoardField,
  next: FieldValue | null,
  shown?: FieldValue,
): BulkChange {
  if (!holdsSeveral(field) || next === null) return update(data, idx, ids, () => ({ custom: { [field.id]: next } }))
  const was = Array.isArray(shown) ? shown : []
  const now = Array.isArray(next) ? next : []
  const added = now.filter((x) => !was.includes(x))
  const removed = new Set(was.filter((x) => !now.includes(x)))
  return update(data, idx, ids, (t) => {
    const own = t.custom?.[field.id]
    const kept = (Array.isArray(own) ? own : []).filter((x) => !removed.has(x))
    const list = [...kept, ...added.filter((x) => !kept.includes(x))]
    return { custom: { [field.id]: list.length ? list : null } }
  })
}

/** "3 cards", "1 card". */
export const cardsWord = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'card' : 'cards'}`

/**
 * What one change to several cards came to, in words: what `said` says of the cards that changed ("Moved 3 cards
 * to Done"), then the ones that stay where they are; or, with no command, why nothing happened.
 */
export function whatHappened(change: BulkChange, said: (cards: string) => string): string {
  const one = change.follow === 1
  const stay = change.follow ? `${cardsWord(change.follow)} ${one ? 'follows its' : 'follow their'} subtasks and ${one ? 'stays' : 'stay'}` : ''
  if (!change.command) return stay ? `Nothing moved: ${stay}.` : 'Nothing to change: they are like that already.'
  return said(cardsWord(change.changed)) + (stay ? `. ${stay[0].toUpperCase()}${stay.slice(1)}.` : '')
}

/**
 * Every card a list shows, moved to another list, from the list's menu ("Move all cards to"): `shown` is the cards
 * the board has in the list as this person sees it (their filter, their search, what a done list leaves out as
 * older), so what moves is what they are looking at. They arrive at the end of the other list in the order they
 * had by hand, whatever order the list was shown in.
 */
export const moveAllTo = (data: BoardData, idx: TaskIndex, shown: readonly string[], status: string): BulkChange =>
  setOnCards(data, idx, byHand(idx, [...shown]), { status })

/**
 * What the list's menu calls that move: "Move all 5 cards to" when the list shows every card it has, "Move the 5
 * cards shown to" when something narrows it, so nobody takes a part of a list for the whole.
 */
export const moveAllWords = (n: number, narrowed: boolean): string =>
  !n ? 'Move all cards to' : narrowed ? `Move the ${cardsWord(n)} shown to` : n === 1 ? 'Move its card to' : `Move all ${cardsWord(n)} to`
