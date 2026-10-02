import { isPast, toDay } from './dates'
import type { Category, Priority } from './types'

/**
 * Searching cards across boards (the Search cards page, and assistants): what a search can ask, and whether a card
 * answers it. Nothing here knows about React or the server: the server turns each card into `CardFacts` and asks.
 */

/** Which cards: on their boards (active), put away (archived), or both. */
export const CARD_STATES = ['archived', 'active', 'all'] as const
export type CardState = (typeof CARD_STATES)[number]

/** Which of a card's dates a time range is about. `any`: whichever of them falls in it. */
export const CARD_DATES = ['any', 'done', 'created', 'changed', 'archived'] as const
export type CardDate = (typeof CARD_DATES)[number]
/** A card's date, as a row shows it: "done 2 days ago". */
export type CardMomentKind = Exclude<CardDate, 'any'>
export const CARD_DATE_LABEL: Record<CardDate, string> = {
  any: 'Anything happened',
  done: 'Done',
  created: 'Made',
  changed: 'Last changed',
  archived: 'Archived',
}
export const CARD_MOMENT_WORD: Record<CardMomentKind, string> = { done: 'done', created: 'made', changed: 'changed', archived: 'archived' }

/** recent: the date asked about, newest first. */
export const CARD_SORTS = ['recent', 'created', 'due', 'priority'] as const
export type CardSort = (typeof CARD_SORTS)[number]
export const CARD_SORT_LABEL: Record<CardSort, string> = { recent: 'Newest first', created: 'Newest made', due: 'Due soonest', priority: 'Priority' }

/** Ranges by name: they move with the calendar, so a saved address for "this week" stays this week. */
export const CARD_RANGES = ['today', 'this-week', 'last-week', '7d', '30d', '90d', 'this-month', 'last-month', 'this-year'] as const
export type CardRange = (typeof CARD_RANGES)[number]
export const CARD_RANGE_LABEL: Record<CardRange, string> = {
  today: 'Today',
  'this-week': 'This week',
  'last-week': 'Last week',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 3 months',
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-year': 'This year',
}

/** The words of a search, lower case. */
export const wordsOf = (q: string | undefined) => q?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
/** Every word appears somewhere in the text (already lower case). */
export const hasWords = (words: string[], text: string) => words.every((w) => text.includes(w))

/** What a search needs to know about one card. Moments are in ms. */
export interface CardFacts {
  /** Everything words can match, lower case: title, description, and its comments. */
  text: string
  assigneeId?: string
  priority?: Priority
  due?: string
  /** Its labels' names, lower case. */
  labels: string[]
  /** The kind of list it shows in. null: archived unfinished (the kind of list wasn't kept). */
  kind: Category | null
  done: boolean
  archived: boolean
  /** It has no subtasks. */
  leaf: boolean
  createdAt: number
  /** The last thing that happened on it: moved, edited or commented on. */
  activeAt: number
  doneAt: number | null
  archivedAt: number | null
}

/** A search. Everything is optional, and everything given must hold. */
export interface CardFilter {
  words?: string[]
  /** A person's id; '' means no one. */
  assignee?: string
  /** '' means no priority. */
  priorities?: (Priority | '')[]
  /** A label's name, lower case. */
  label?: string
  due?: 'overdue' | 'week' | 'none'
  /** Today's day number where the person is (for `due`). */
  today?: number
  kinds?: Category[]
  completed?: boolean
  when?: CardDate
  /** The range: from this moment up to (not including) that one, in ms. */
  from?: number
  to?: number
  /** Only cards without subtasks. */
  leaves?: boolean
}

// When two of a card's dates are the same moment (moving it to Done also changes it), the more telling one wins.
const TELLING: CardMomentKind[] = ['archived', 'done', 'created', 'changed']

/**
 * The date of a card a search is about, or null when it has none in the range: the one asked for (`when`), or for
 * "anything", the latest of its dates in the range. With no range: when it was archived, or last changed.
 */
export function cardMoment(c: CardFacts, f: Pick<CardFilter, 'when' | 'from' | 'to'>): { at: number; kind: CardMomentKind } | null {
  const dates: Record<CardMomentKind, number | null> = { archived: c.archivedAt, done: c.doneAt, created: c.createdAt, changed: c.activeAt }
  const ranged = f.from !== undefined || f.to !== undefined
  const within = (ms: number | null): ms is number => ms !== null && ms >= (f.from ?? -Infinity) && ms < (f.to ?? Infinity)
  if (f.when && f.when !== 'any') return within(dates[f.when]) ? { at: dates[f.when]!, kind: f.when } : null
  if (!ranged) return c.archivedAt !== null ? { at: c.archivedAt, kind: 'archived' } : { at: c.activeAt, kind: 'changed' }
  let best: { at: number; kind: CardMomentKind } | null = null
  for (const kind of TELLING) {
    const at = dates[kind]
    if (within(at) && (!best || at > best.at)) best = { at, kind }
  }
  return best
}

export function matchesCard(c: CardFacts, f: CardFilter): boolean {
  if (f.leaves && !c.leaf) return false
  if (f.completed !== undefined && c.done !== f.completed) return false
  if (f.kinds?.length && !(c.kind && f.kinds.includes(c.kind))) return false
  if (f.assignee !== undefined && (c.assigneeId ?? '') !== f.assignee) return false
  if (f.priorities?.length && !f.priorities.includes(c.priority ?? '')) return false
  if (f.label && !c.labels.includes(f.label)) return false
  if (f.due === 'none' && c.due) return false
  if (f.due === 'overdue' && (!c.due || c.done || !isPast(c.due))) return false
  if (f.due === 'week') {
    const d = c.due && f.today !== undefined ? toDay(c.due) - f.today : NaN
    if (!(d >= 0 && d <= 7)) return false
  }
  if (f.words?.length && !hasWords(f.words, c.text)) return false
  return cardMoment(c, f) !== null
}

/** Putting the cards found in order. Without the value asked for, a card goes last. */
export function compareCards(sort: CardSort) {
  type Sortable = { at: number; createdAt: number; due?: string; priority?: Priority }
  const PRIORITY: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
  const due = (c: Sortable) => (c.due ? toDay(c.due) : Infinity)
  const priority = (c: Sortable) => (c.priority ? PRIORITY[c.priority] : 4)
  return (a: Sortable, b: Sortable): number => {
    if (sort === 'created') return b.createdAt - a.createdAt
    if (sort === 'due') return due(a) - due(b) || b.at - a.at
    if (sort === 'priority') return priority(a) - priority(b) || due(a) - due(b) || b.at - a.at
    return b.at - a.at
  }
}

const startOfDay = (d: Date, shift = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift)
/** Days since Monday. */
const weekday = (d: Date) => (d.getDay() + 6) % 7

/** A named range as two moments where you are (`from` up to, not including, `to`). Weeks start on Monday. */
export function resolveRange(range: CardRange, now = new Date()): { from: Date; to: Date } {
  const tomorrow = startOfDay(now, 1)
  const monday = startOfDay(now, -weekday(now))
  switch (range) {
    case 'today':
      return { from: startOfDay(now), to: tomorrow }
    case 'this-week':
      return { from: monday, to: startOfDay(monday, 7) }
    case 'last-week':
      return { from: startOfDay(monday, -7), to: monday }
    case '7d':
      return { from: startOfDay(now, -6), to: tomorrow }
    case '30d':
      return { from: startOfDay(now, -29), to: tomorrow }
    case '90d':
      return { from: startOfDay(now, -89), to: tomorrow }
    case 'this-month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) }
    case 'last-month':
      return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) }
    case 'this-year':
      return { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear() + 1, 0, 1) }
  }
}

/** Two days (YYYY-MM-DD, either may be missing) as a range of moments where you are: from the start of one to the end of the other. */
export function resolveDays(from: string | undefined, to: string | undefined): { from?: Date; to?: Date } {
  const day = (v: string, shift: number) => {
    const [y, m, d] = v.split('-').map(Number)
    return new Date(y, m - 1, d + shift)
  }
  return { ...(from && { from: day(from, 0) }), ...(to && { to: day(to, 1) }) }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The heading a moment goes under in a list sorted by date: Today, Yesterday, this week, last week, then by month. */
export function periodOf(ms: number, now = new Date()): string {
  const today = startOfDay(now).getTime()
  const monday = startOfDay(now, -weekday(now)).getTime()
  if (ms >= startOfDay(now, 1).getTime()) return 'Later'
  if (ms >= today) return 'Today'
  if (ms >= startOfDay(now, -1).getTime()) return 'Yesterday'
  if (ms >= monday) return 'Earlier this week'
  if (ms >= startOfDay(new Date(monday), -7).getTime()) return 'Last week'
  const d = new Date(ms)
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'Earlier this month'
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
