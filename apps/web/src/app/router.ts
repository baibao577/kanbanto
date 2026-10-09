import { useSyncExternalStore } from 'react'
import { CARD_DATES, CARD_RANGES, CARD_SORTS, type CardDate, type CardRange, type CardSort, type CardState } from '@kanbanto/model/search'
import { dueFromText, dueToText } from '@kanbanto/model/table'
import { CATEGORIES, LAYOUTS, PRIORITIES, type Category, type Layout, type Priority } from '@kanbanto/model/types'

/**
 * Pages:
 *   #/                       your boards
 *   #/b/<id>/<tab>?focus=<task>&task=<task>   a board. The address carries what you're looking at, so
 *                            Back/Forward and links bring it back. A bare #/b/<id> means "as I left it".
 *   …?inbox=<task>           on either of those: a card of your Inbox, open on top (see app/inbox.tsx)
 *   #/join/<token>           a share link (or an email invite), to a board or a workspace
 *   #/w/<id>                 a workspace's people and settings
 *   #/w/<id>/fields          its fields: what its boards can add to cards (see model/fields.ts)
 *   #/w/<id>/planning?by=person&zoom=days   its plan: who works on which project (by project, in weeks, unless said)
 *   #/cards?q=<words>&assignee=me&when=done&range=this-week…   search cards across boards. The address holds the
 *                            whole search (see CardsRoute), so it can be kept and shared. state=archived: the archived ones.
 *   #/time?week=<monday>      My week: your logged time on every board (this week, unless said)
 *   #/authorize?<oauth params>   approving an app that connects with sign-in (from /oauth/authorize)
 *   #/signin, #/signup       (?next=<where to go after>)
 *   #/forgot                 ask for a password reset email
 *   #/verify/<token>, #/reset/<token>   links from emails
 *   #/account/<section>      your account settings (profile, password, notifications, calendar, fields, email, storage,
 *                            api);
 *                            ?problem=<what> says why connecting Google Calendar didn't work (see Calendar.tsx)
 *   #/admin/<section>        the Platform console (overview, accounts, email, storage, integrations)
 * Hash addresses work on any static host, with no server rewrite rules.
 */
/** `n`: a card by its number on the board (from a name like WEB-12 written somewhere): looked up, then the address says `task`. */
/**
 * `full`: the open card's description is shown full page (so a link can lead straight to a card as a page to read).
 * `note`: at a comment about some of its words (where the bell leads for such a comment).
 */
export type BoardRoute = {
  page: 'board'
  id: string
  layout?: Layout
  focus?: string
  task?: string
  full?: boolean
  note?: string
  inbox?: string
  n?: string
}
export type HomeRoute = { page: 'home'; inbox?: string }
/** A workspace: its people (the default), or its plan, shown by project or by person, in weeks or days. */
export type WorkspaceRoute = { page: 'workspace'; id: string; section?: WorkspaceSection; by?: 'person'; zoom?: 'days' | 'months' }
/**
 * The Search cards page: which cards (the ones on their boards, unless said), where, and what about them. A time range
 * is a named one (`range`, which moves with the calendar) or two days (`from`, `to`), about one of a card's dates
 * (`when`).
 */
export type CardsRoute = {
  page: 'cards'
  state: CardState
  board?: string
  /** A workspace's id, `personal` or `shared`. */
  place?: string
  q?: string
  completed?: boolean
  kinds?: Category[]
  /** `me`, `none`, or a person's id. */
  assignee?: string
  priorities?: (Priority | 'none')[]
  label?: string
  /** A test of the due date, as text: "overdue", "week", "none", "today", "this-month", "next-30"… (see `dueFromText`). */
  due?: string
  when?: CardDate
  range?: CardRange
  /** Days, YYYY-MM-DD. */
  from?: string
  to?: string
  /** Leave out cards that have subtasks. */
  leaves?: boolean
  /** Only the cards you follow. */
  following?: boolean
  /**
   * One of the boards' own fields, by id: rows say what each card has for it. `fv`: what it has to be, as text (see
   * `filterToText` in model/fields.ts); without it nothing is left out.
   */
  field?: string
  fv?: string
  sort?: CardSort
}
export type Route =
  | HomeRoute
  | BoardRoute
  | { page: 'join'; token: string }
  | WorkspaceRoute
  | CardsRoute
  | { page: 'time'; week?: string }
  | { page: 'authorize'; query: string }
  | { page: 'verify'; token: string }
  | { page: 'reset'; token: string }
  | { page: 'forgot' }
  /** `problem`: why signing in with Google didn't work (the server sends people back with it, see its routes/google-auth.ts). */
  | { page: 'signin'; next?: string; problem?: string }
  | { page: 'signup'; next?: string }
  | { page: 'admin'; section?: AdminSection }
  | { page: 'account'; section?: AccountSection; problem?: string }
  /**
   * The little "add a card" page, with what a page handed over: its title, its address, and selected or shared words.
   * `w`: opened as a small window of its own (by the bookmark button), which closes once the card is added.
   */
  | { page: 'add'; title?: string; url?: string; text?: string; w?: boolean }

export const ADMIN_SECTIONS = ['overview', 'accounts', 'email', 'storage', 'integrations'] as const
export type AdminSection = (typeof ADMIN_SECTIONS)[number]
export const WORKSPACE_SECTIONS = ['people', 'planning', 'fields'] as const
export type WorkspaceSection = Exclude<(typeof WORKSPACE_SECTIONS)[number], 'people'>
export const ACCOUNT_SECTIONS = ['profile', 'password', 'notifications', 'calendar', 'fields', 'email', 'storage', 'api', 'add'] as const
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]

export function parseRoute(hash: string): Route {
  const token = hash.match(/^#\/(join|verify|reset)\/([^/?#]+)/)
  if (token) return { page: token[1] as 'join' | 'verify' | 'reset', token: decodeURIComponent(token[2]) }
  if (/^#\/forgot\/?$/.test(hash)) return { page: 'forgot' }
  const authorize = hash.match(/^#\/authorize\?(.*)$/)
  if (authorize) return { page: 'authorize', query: authorize[1] }
  const add = hash.match(/^#\/add\/?(?:\?(.*))?$/)
  if (add) {
    const p = new URLSearchParams(add[1] ?? '')
    // (Whatever a page hands over is cut to what a card can hold.)
    const said = (key: string, most: number) => p.get(key)?.slice(0, most) || undefined
    const [title, url, text] = [said('title', 500), said('url', 2000), said('text', 2000)]
    return { page: 'add', ...(title && { title }), ...(url && { url }), ...(text && { text }), ...(p.get('w') === '1' && { w: true }) }
  }
  const time = hash.match(/^#\/time\/?(?:\?(.*))?$/)
  if (time) {
    const week = new URLSearchParams(time[1] ?? '').get('week')
    return { page: 'time', ...(week && /^\d{4}-\d{2}-\d{2}$/.test(week) && { week }) }
  }
  const cards = hash.match(/^#\/cards\/?(?:\?(.*))?$/)
  if (cards) {
    const p = new URLSearchParams(cards[1] ?? '')
    const done = p.get('completed')
    const one = <T extends string>(key: string, values: readonly T[]) => values.find((v) => v === p.get(key))
    const some = <T extends string>(key: string, values: readonly T[]) => (p.get(key) ?? '').split(',').flatMap((v) => values.filter((x) => x === v))
    const day = (key: string) => (/^\d{4}-\d{2}-\d{2}$/.test(p.get(key) ?? '') ? p.get(key)! : undefined)
    const due = dueFromText(p.get('due') ?? '')
    const state = one('state', ['archived', 'all'] as const) ?? 'active'
    const kinds = some('kind', CATEGORIES)
    const priorities = some('priority', [...PRIORITIES, 'none'] as const)
    const range = one('range', CARD_RANGES)
    return {
      page: 'cards',
      state,
      ...(p.get('board') && { board: p.get('board')! }),
      ...(p.get('place') && { place: p.get('place')! }),
      ...(p.get('q') && { q: p.get('q')! }),
      ...((done === 'yes' || done === 'no') && { completed: done === 'yes' }),
      ...(kinds.length && { kinds }),
      ...(p.get('assignee') && { assignee: p.get('assignee')! }),
      ...(priorities.length && { priorities }),
      ...(p.get('label') && { label: p.get('label')! }),
      // (Written the one way each test is: "next-7" is "week".)
      ...(due && { due: dueToText(due) }),
      ...(one('when', CARD_DATES) && one('when', CARD_DATES) !== 'any' && { when: one('when', CARD_DATES) }),
      // A named range, or days: not both.
      ...(range ? { range } : { ...(day('from') && { from: day('from') }), ...(day('to') && { to: day('to') }) }),
      ...(p.get('parents') === 'hide' && { leaves: true }),
      ...(p.get('following') === 'yes' && { following: true }),
      ...(p.get('field') && { field: p.get('field')!, ...(p.get('fv') && { fv: p.get('fv')! }) }),
      ...(one('sort', CARD_SORTS) && one('sort', CARD_SORTS) !== 'recent' && { sort: one('sort', CARD_SORTS) }),
    }
  }
  const ws = hash.match(/^#\/w\/([^/?#]+)(?:\/([a-z]+))?\/?(?:\?(.*))?$/)
  if (ws) {
    const planning = ws[2] === 'planning'
    const q = new URLSearchParams(ws[3] ?? '')
    return {
      page: 'workspace',
      id: decodeURIComponent(ws[1]),
      ...(planning && { section: 'planning' as const }),
      ...(ws[2] === 'fields' && { section: 'fields' as const }),
      ...(planning && q.get('by') === 'person' && { by: 'person' as const }),
      ...(planning && (q.get('zoom') === 'days' || q.get('zoom') === 'months') && { zoom: q.get('zoom') as 'days' | 'months' }),
    }
  }
  const auth = hash.match(/^#\/(signin|signup)(?:\?(.*))?$/)
  if (auth) {
    const q = new URLSearchParams(auth[2] ?? '')
    const [next, problem] = [q.get('next'), q.get('problem')]
    if (auth[1] === 'signup') return { page: 'signup', ...(next && { next }) }
    return { page: 'signin', ...(next && { next }), ...(problem && { problem }) }
  }
  const account = hash.match(/^#\/account(?:\/([a-z]+))?\/?(?:\?(.*))?$/)
  if (account) {
    const section = ACCOUNT_SECTIONS.find((s) => s === account[1])
    const problem = new URLSearchParams(account[2] ?? '').get('problem')
    return { page: 'account', ...(section && section !== 'profile' && { section }), ...(problem && { problem }) }
  }
  const admin = hash.match(/^#\/admin(?:\/([a-z]+))?\/?$/)
  if (admin) {
    const section = ADMIN_SECTIONS.find((s) => s === admin[1])
    return { page: 'admin', ...(section && section !== 'overview' && { section }) }
  }
  const m = hash.match(/^#\/b\/([^/?#]+)(?:\/([a-z]+))?\/?(?:\?(.*))?$/)
  if (!m) {
    const inbox = new URLSearchParams(hash.match(/^#\/?\?(.*)$/)?.[1] ?? '').get('inbox')
    return { page: 'home', ...(inbox && { inbox }) }
  }
  const q = new URLSearchParams(m[3] ?? '')
  const layout = LAYOUTS.find((l) => l === m[2])
  return {
    page: 'board',
    id: decodeURIComponent(m[1]),
    ...(layout && { layout }),
    ...(q.get('focus') && { focus: q.get('focus')! }),
    ...(q.get('task') && { task: q.get('task')! }),
    ...(q.get('task') && q.get('full') === '1' && { full: true }),
    ...(q.get('task') && q.get('full') === '1' && /^[0-9a-f-]{36}$/.test(q.get('note') ?? '') && { note: q.get('note')! }),
    ...(q.get('inbox') && { inbox: q.get('inbox')! }),
    ...(/^[1-9]\d{0,8}$/.test(q.get('n') ?? '') && { n: q.get('n')! }),
  }
}

export function hrefFor(r: Route) {
  if (r.page === 'home') return r.inbox ? `#/?inbox=${encodeURIComponent(r.inbox)}` : '#/'
  if (r.page === 'account')
    return `${r.section && r.section !== 'profile' ? `#/account/${r.section}` : '#/account'}${r.problem ? `?problem=${encodeURIComponent(r.problem)}` : ''}`
  if (r.page === 'admin') return r.section && r.section !== 'overview' ? `#/admin/${r.section}` : '#/admin'
  if (r.page === 'forgot') return '#/forgot'
  if (r.page === 'workspace') {
    if (r.section === 'fields') return `#/w/${encodeURIComponent(r.id)}/fields`
    if (r.section !== 'planning') return `#/w/${encodeURIComponent(r.id)}`
    const q = new URLSearchParams()
    if (r.by) q.set('by', r.by)
    if (r.zoom) q.set('zoom', r.zoom)
    const qs = q.toString()
    return `#/w/${encodeURIComponent(r.id)}/planning${qs ? `?${qs}` : ''}`
  }
  if (r.page === 'cards') {
    const p = new URLSearchParams()
    if (r.state !== 'active') p.set('state', r.state)
    if (r.board) p.set('board', r.board)
    if (r.place) p.set('place', r.place)
    if (r.q) p.set('q', r.q)
    if (r.completed !== undefined) p.set('completed', r.completed ? 'yes' : 'no')
    if (r.kinds?.length) p.set('kind', r.kinds.join(','))
    if (r.assignee) p.set('assignee', r.assignee)
    if (r.priorities?.length) p.set('priority', r.priorities.join(','))
    if (r.label) p.set('label', r.label)
    if (r.due) p.set('due', r.due)
    if (r.when && r.when !== 'any') p.set('when', r.when)
    if (r.range) p.set('range', r.range)
    else {
      if (r.from) p.set('from', r.from)
      if (r.to) p.set('to', r.to)
    }
    if (r.leaves) p.set('parents', 'hide')
    if (r.following) p.set('following', 'yes')
    if (r.field) p.set('field', r.field)
    if (r.field && r.fv) p.set('fv', r.fv)
    if (r.sort && r.sort !== 'recent') p.set('sort', r.sort)
    const qs = p.toString()
    return `#/cards${qs ? `?${qs}` : ''}`
  }
  if (r.page === 'time') return `#/time${r.week ? `?week=${r.week}` : ''}`
  if (r.page === 'add') {
    const p = new URLSearchParams()
    if (r.w) p.set('w', '1')
    if (r.title) p.set('title', r.title)
    if (r.url) p.set('url', r.url)
    if (r.text) p.set('text', r.text)
    const qs = p.toString()
    return `#/add${qs ? `?${qs}` : ''}`
  }
  if (r.page === 'authorize') return `#/authorize?${r.query}`
  if (r.page === 'join' || r.page === 'verify' || r.page === 'reset') return `#/${r.page}/${encodeURIComponent(r.token)}`
  if (r.page === 'signin' || r.page === 'signup') {
    const problem = r.page === 'signin' && r.problem ? `problem=${encodeURIComponent(r.problem)}` : ''
    const qs = [problem, r.next ? `next=${encodeURIComponent(r.next)}` : ''].filter(Boolean).join('&')
    return `#/${r.page}${qs ? `?${qs}` : ''}`
  }
  const q = new URLSearchParams()
  if (r.focus) q.set('focus', r.focus)
  if (r.task) q.set('task', r.task)
  if (r.task && r.full) q.set('full', '1')
  if (r.task && r.full && r.note) q.set('note', r.note)
  if (r.inbox) q.set('inbox', r.inbox)
  if (r.n) q.set('n', r.n)
  const qs = q.toString()
  return `#/b/${encodeURIComponent(r.id)}${r.layout ? `/${r.layout}` : ''}${qs ? `?${qs}` : ''}`
}

/** What we keep in history.state: how many task dialogs deep this entry is (see `openTask`). */
type EntryState = { taskDepth?: number } | null

export function navigate(r: Route, { replace = false, state = null as EntryState } = {}) {
  const href = hrefFor(r)
  if (replace) history.replaceState(state, '', href)
  else history.pushState(state, '', href)
  // pushState doesn't fire hashchange; tell listeners ourselves.
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** The route right now (for event handlers, which may run before React re-renders). */
export const currentRoute = () => parseRoute(location.hash)

const taskDepth = () => (history.state as EntryState)?.taskDepth ?? 0

/** Opens a task on top of the current page. Each task opened from another adds to the depth. */
export function openTask(id: string) {
  const r = currentRoute()
  if (r.page !== 'board' || r.task === id) return
  navigate({ ...r, task: id, full: undefined, note: undefined }, { state: { taskDepth: r.task ? taskDepth() + 1 : 1 } })
}

/** Closes the task dialog by going back to where you were before the first task was opened. */
export function closeTask() {
  const r = currentRoute()
  if (r.page !== 'board' || !r.task) return
  const depth = taskDepth()
  if (depth > 0) history.go(-depth)
  else navigate({ ...r, task: undefined, full: undefined, note: undefined }, { replace: true })
}

/** Whether the address asks for this card's description full page (it is the open card, and the address says so). */
export function wantsFullPage(taskId: string) {
  const r = currentRoute()
  return r.page === 'board' && r.task === taskId && !!r.full
}

/** The comment the address asks that full page to open at (see `BoardRoute.note`), if any. */
export function wantsNote(taskId: string): string | null {
  const r = currentRoute()
  return (r.page === 'board' && r.task === taskId && r.full && r.note) || null
}

/**
 * Says in the address that the open card's description is full page now, or no longer is: the address copied then
 * leads to the same. The same place in history (Back still leaves the card, as before).
 */
export function setFullPage(taskId: string, on: boolean) {
  const r = currentRoute()
  if (r.page !== 'board' || r.task !== taskId || (!!r.full === on && !r.note)) return
  // (Which comment it opened at was for the way in: the address is the page's own from then on.)
  navigate({ ...r, full: on || undefined, note: undefined }, { replace: true, state: history.state as EntryState })
}

/** Opens a card of your Inbox on top of the current page (a board, or your boards), like `openTask`. */
export function openInboxCard(id: string) {
  const r = currentRoute()
  if ((r.page !== 'board' && r.page !== 'home') || r.inbox === id) return
  navigate({ ...r, inbox: id }, { state: { taskDepth: r.inbox ? taskDepth() + 1 : 1 } })
}

/** Closes it, going back to where you were before the first one was opened. */
export function closeInboxCard() {
  const r = currentRoute()
  if ((r.page !== 'board' && r.page !== 'home') || !r.inbox) return
  const depth = taskDepth()
  if (depth > 0) history.go(-depth)
  else navigate({ ...r, inbox: undefined }, { replace: true })
}

let cached: { hash: string; route: Route } | null = null
const snapshot = () => {
  if (cached?.hash !== location.hash) cached = { hash: location.hash, route: parseRoute(location.hash) }
  return cached.route
}

export function useRoute(): Route {
  return useSyncExternalStore((onChange) => {
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, snapshot)
}
