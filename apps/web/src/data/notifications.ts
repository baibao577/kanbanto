import type { NotificationView } from '@kanbanto/model/api'
import { api } from '@/api/client'
import type { Route } from '@/app/router'

// Your notifications, as the bell and the page of them all ask for them, and what can be done with one. Whichever
// of the two changes something says so here, so the other shows the same.

export interface NotificationsPage {
  notifications: NotificationView[]
  /** How many are unread in all, whatever was asked for. */
  unread: number
  /** Where the next page starts (see `before`); null: these were the last. */
  next: string | null
}

export interface NotificationsQuery {
  limit?: number
  before?: string
  unread?: boolean
  mentions?: boolean
  board?: string
}

export function fetchNotifications(q: NotificationsQuery = {}): Promise<NotificationsPage> {
  const p = new URLSearchParams()
  if (q.limit) p.set('limit', String(q.limit))
  if (q.before) p.set('before', q.before)
  if (q.unread) p.set('unread', '1')
  if (q.mentions) p.set('mentions', '1')
  if (q.board) p.set('board', q.board)
  const qs = p.toString()
  return api<NotificationsPage>('GET', `/notifications${qs ? `?${qs}` : ''}`)
}

const watchers = new Set<() => void>()
const changed = () => {
  for (const w of watchers) w()
}
/** Told whenever a notification was marked read or unread from anywhere in the app. */
export function onNotificationsChanged(told: () => void): () => void {
  watchers.add(told)
  return () => void watchers.delete(told)
}

/** Marks these read; without any: all that are new (the ones turned back to unread by hand stay). */
export const markRead = (ids?: string[]) => api('POST', '/notifications/read', ids ? { ids } : {}).then(changed)
/** Turns one back to unread, to come back to, or marks it read. */
export const setRead = (id: string, read: boolean) => api('PUT', `/notifications/${id}/read`, { read }).then(changed)

/** Where a notification leads: the card (at the comment's words, when it is about some), the board, the workspace. */
export function whereTo(n: NotificationView): Route | null {
  if (n.kind === 'added') return n.board ? { page: 'board', id: n.board.id } : n.workspace ? { page: 'workspace', id: n.workspace.id } : null
  if (!n.board.id) return null
  // (A comment about words of a description opens at those words, on its full page.)
  const thread = 'thread' in n && n.task.id ? n.thread : undefined
  return { page: 'board', id: n.board.id, ...(n.task.id && { task: n.task.id }), ...(thread && { full: true, note: thread }) }
}
