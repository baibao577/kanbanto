import { format } from 'date-fns'
import { CARD_DATE_LABEL, CARD_MOMENT_WORD, CARD_RANGE_LABEL, resolveDays, resolveRange, type CardMomentKind } from '@kanbanto/model/search'
import type { Category } from '@kanbanto/model/types'
import type { CardsRoute } from '@/app/router'

/** What the Search cards page asks the server, and how it says what it's showing. Nothing here knows about React. */

/** The keys that open Search cards from anywhere (see App). */
export const SEARCH_KEYS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'

/** A search, without where it's shown: what the address holds. */
export type Search = Omit<CardsRoute, 'page'>

/** The address as the question for GET /api/cards: named ranges and days become moments where you are. */
export function cardsQuery(r: Search, opts: { offset?: number; now?: Date } = {}): string {
  const p = new URLSearchParams({ state: r.state })
  if (r.board) p.set('board', r.board)
  if (r.place) p.set('place', r.place)
  if (r.q) p.set('q', r.q)
  if (r.completed !== undefined) p.set('completed', String(r.completed))
  if (r.kinds?.length) p.set('kind', r.kinds.join(','))
  if (r.assignee) p.set('assignee', r.assignee)
  if (r.priorities?.length) p.set('priority', r.priorities.join(','))
  if (r.label) p.set('label', r.label)
  if (r.due) p.set('due', r.due)
  if (r.when) p.set('when', r.when)
  const { from, to } = r.range ? resolveRange(r.range, opts.now) : resolveDays(r.from, r.to)
  if (from) p.set('from', from.toISOString())
  if (to) p.set('to', to.toISOString())
  if (r.leaves) p.set('parents', 'hide')
  if (r.following) p.set('following', 'true')
  if (r.field) p.set('field', r.field)
  if (r.field && r.fv) p.set('fv', r.fv)
  if (r.sort) p.set('sort', r.sort)
  if (opts.offset) p.set('offset', String(opts.offset))
  return p.toString()
}

/** Searches to start from. Choosing one replaces the filters (where and the words stay). */
export const QUICK: { id: string; label: string; hint: string; search: Search }[] = [
  { id: 'mine', label: 'My tasks', hint: 'Assigned to you, not done yet', search: { state: 'active', assignee: 'me', completed: false } },
  {
    id: 'following',
    label: 'Following',
    hint: 'Cards you’re told about, not done yet',
    search: { state: 'active', following: true, completed: false },
  },
  {
    id: 'done-week',
    label: 'Done this week',
    hint: 'What you finished since Monday, archived or not',
    search: { state: 'all', assignee: 'me', when: 'done', range: 'this-week' },
  },
  {
    id: 'recent',
    label: 'Recently changed',
    hint: 'Moved, edited or commented on in the last 7 days',
    search: { state: 'active', when: 'changed', range: '7d' },
  },
  { id: 'archived', label: 'Archived', hint: 'Cards put away, newest first', search: { state: 'archived' } },
]

/** The filters of a search, apart from where it looks, its words and its order. */
const filtersOf = ({ page: _page, board: _b, place: _p, q: _q, sort: _s, ...f }: Search & { page?: 'cards' }) => f
const same = (a: object, b: object) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

/** The quick search this one is, if it is one. */
export const quickOf = (r: Search) => QUICK.find((x) => same(filtersOf(r), x.search))?.id
/** Is anything narrowing it (beyond where it looks and the words)? */
export const isFiltered = (r: Search) => !same(filtersOf(r), { state: 'active' })

/** Status, as one choice: it covers "done or not" and the kinds of list. */
export const STATUSES = [
  { id: 'any', label: 'Any status' },
  { id: 'open', label: 'Not done' },
  { id: 'todo', label: 'Not started' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
] as const
export type StatusChoice = (typeof STATUSES)[number]['id']
const KINDS: Partial<Record<StatusChoice, Category[]>> = { todo: ['backlog', 'todo'], doing: ['doing'] }

export function statusOf(r: Search): StatusChoice {
  if (r.completed !== undefined) return r.completed ? 'done' : 'open'
  const kinds = [...(r.kinds ?? [])].sort().join()
  return kinds === 'doing' ? 'doing' : kinds === 'backlog,todo' ? 'todo' : 'any'
}
export const withStatus = (s: StatusChoice): Pick<Search, 'completed' | 'kinds'> => ({
  completed: s === 'done' ? true : s === 'open' ? false : undefined,
  kinds: KINDS[s],
})

const dayWords = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return format(new Date(y, m - 1, d), y === new Date().getFullYear() ? 'd MMM' : 'd MMM yyyy')
}

/** The time range in words: "Any time", "Done · This week", "Made · 1 Jul – 30 Sep". */
export function whenWords(r: Search): string {
  const range = r.range
    ? CARD_RANGE_LABEL[r.range]
    : r.from && r.to
      ? r.from === r.to
        ? dayWords(r.from)
        : `${dayWords(r.from)} – ${dayWords(r.to)}`
      : r.from
        ? `Since ${dayWords(r.from)}`
        : r.to
          ? `Until ${dayWords(r.to)}`
          : null
  if (!r.when || r.when === 'any') return range ?? 'Any time'
  return range ? `${CARD_DATE_LABEL[r.when]} · ${range}` : `${CARD_DATE_LABEL[r.when]}, any time`
}

/** A row's date: "done 5m ago", "archived 3 Oct", "made 12 Mar 2025". */
export function momentWords(kind: CardMomentKind, iso: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000)
  const d = new Date(iso)
  const ago =
    min < 1
      ? 'just now'
      : min < 60
        ? `${min}m ago`
        : min < 24 * 60
          ? `${Math.floor(min / 60)}h ago`
          : min < 7 * 24 * 60
            ? `${Math.floor(min / 1440)}d ago`
            : format(d, d.getFullYear() === new Date(now).getFullYear() ? 'd MMM' : 'd MMM yyyy')
  return `${CARD_MOMENT_WORD[kind]} ${ago}`
}
