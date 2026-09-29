import { useSyncExternalStore } from 'react'
import { LAYOUTS, type Layout } from '@kanbanto/model/types'

/**
 * Pages:
 *   #/                       your boards
 *   #/b/<id>/<tab>?focus=<task>&task=<task>   a board. The address carries what you're looking at, so
 *                            Back/Forward and links bring it back. A bare #/b/<id> means "as I left it".
 *   #/join/<token>           a share link (or an email invite), to a board or a workspace
 *   #/w/<id>                 a workspace's people and settings
 *   #/signin, #/signup       (?next=<where to go after>)
 *   #/forgot                 ask for a password reset email
 *   #/verify/<token>, #/reset/<token>   links from emails
 *   #/account/<section>      your account settings (profile, password, notifications, email, storage)
 *   #/admin/<section>        the Platform console (overview, accounts, email, storage)
 * Hash addresses work on any static host, with no server rewrite rules.
 */
export type BoardRoute = { page: 'board'; id: string; layout?: Layout; focus?: string; task?: string }
export type Route =
  | { page: 'home' }
  | BoardRoute
  | { page: 'join'; token: string }
  | { page: 'workspace'; id: string }
  | { page: 'verify'; token: string }
  | { page: 'reset'; token: string }
  | { page: 'forgot' }
  | { page: 'signin'; next?: string }
  | { page: 'signup'; next?: string }
  | { page: 'admin'; section?: AdminSection }
  | { page: 'account'; section?: AccountSection }

export const ADMIN_SECTIONS = ['overview', 'accounts', 'email', 'storage'] as const
export type AdminSection = (typeof ADMIN_SECTIONS)[number]
export const ACCOUNT_SECTIONS = ['profile', 'password', 'notifications', 'email', 'storage'] as const
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]

export function parseRoute(hash: string): Route {
  const token = hash.match(/^#\/(join|verify|reset)\/([^/?#]+)/)
  if (token) return { page: token[1] as 'join' | 'verify' | 'reset', token: decodeURIComponent(token[2]) }
  if (/^#\/forgot\/?$/.test(hash)) return { page: 'forgot' }
  const ws = hash.match(/^#\/w\/([^/?#]+)\/?$/)
  if (ws) return { page: 'workspace', id: decodeURIComponent(ws[1]) }
  const auth = hash.match(/^#\/(signin|signup)(?:\?(.*))?$/)
  if (auth) {
    const next = new URLSearchParams(auth[2] ?? '').get('next')
    return { page: auth[1] as 'signin' | 'signup', ...(next && { next }) }
  }
  const account = hash.match(/^#\/account(?:\/([a-z]+))?\/?$/)
  if (account) {
    const section = ACCOUNT_SECTIONS.find((s) => s === account[1])
    return { page: 'account', ...(section && section !== 'profile' && { section }) }
  }
  const admin = hash.match(/^#\/admin(?:\/([a-z]+))?\/?$/)
  if (admin) {
    const section = ADMIN_SECTIONS.find((s) => s === admin[1])
    return { page: 'admin', ...(section && section !== 'overview' && { section }) }
  }
  const m = hash.match(/^#\/b\/([^/?#]+)(?:\/([a-z]+))?\/?(?:\?(.*))?$/)
  if (!m) return { page: 'home' }
  const q = new URLSearchParams(m[3] ?? '')
  const layout = LAYOUTS.find((l) => l === m[2])
  return {
    page: 'board',
    id: decodeURIComponent(m[1]),
    ...(layout && { layout }),
    ...(q.get('focus') && { focus: q.get('focus')! }),
    ...(q.get('task') && { task: q.get('task')! }),
  }
}

export function hrefFor(r: Route) {
  if (r.page === 'home') return '#/'
  if (r.page === 'account') return r.section && r.section !== 'profile' ? `#/account/${r.section}` : '#/account'
  if (r.page === 'admin') return r.section && r.section !== 'overview' ? `#/admin/${r.section}` : '#/admin'
  if (r.page === 'forgot') return '#/forgot'
  if (r.page === 'workspace') return `#/w/${encodeURIComponent(r.id)}`
  if (r.page === 'join' || r.page === 'verify' || r.page === 'reset') return `#/${r.page}/${encodeURIComponent(r.token)}`
  if (r.page === 'signin' || r.page === 'signup') return `#/${r.page}${r.next ? `?next=${encodeURIComponent(r.next)}` : ''}`
  const q = new URLSearchParams()
  if (r.focus) q.set('focus', r.focus)
  if (r.task) q.set('task', r.task)
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
  navigate({ ...r, task: id }, { state: { taskDepth: r.task ? taskDepth() + 1 : 1 } })
}

/** Closes the task dialog by going back to where you were before the first task was opened. */
export function closeTask() {
  const r = currentRoute()
  if (r.page !== 'board' || !r.task) return
  const depth = taskDepth()
  if (depth > 0) history.go(-depth)
  else navigate({ ...r, task: undefined }, { replace: true })
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
