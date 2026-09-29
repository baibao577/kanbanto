import { Bell } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useState } from 'react'
import type { NotificationView } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const fetchNotifications = () => api<{ notifications: NotificationView[]; unread: number }>('GET', '/notifications')

/**
 * The bell: @mentions of you, and boards or workspaces someone added you to, newest first. Checked every minute and
 * when you come back to the tab.
 */
export function NotificationBell() {
  const { user } = useAuth()
  const [items, setItems] = useState<NotificationView[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)

  const apply = useCallback((r: { notifications: NotificationView[]; unread: number }) => {
    setItems(r.notifications)
    setUnread(r.unread)
  }, [])
  const refresh = useCallback(() => void fetchNotifications().then(apply, () => {}), [apply])

  useEffect(() => {
    if (!user) return
    fetchNotifications().then(apply, () => {})
    const timer = setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [user, apply, refresh])

  if (!user) return null

  const openOne = (n: NotificationView) => {
    setOpen(false)
    if (!n.read) void api('POST', '/notifications/read', { ids: [n.id] }).then(refresh)
    if (n.kind === 'mention') navigate({ page: 'board', id: n.board.id, task: n.task.id })
    else if (n.board) navigate({ page: 'board', id: n.board.id })
    else if (n.workspace) navigate({ page: 'workspace', id: n.workspace.id })
  }

  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && refresh())}>
      <PopoverTrigger asChild>
        <button
          aria-label={unread ? `Notifications (${unread} new)` : 'Notifications'}
          className="relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Bell className="size-5" />
          {unread > 0 && (
            <span className="absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void api('POST', '/notifications/read', {}).then(refresh)}
            >
              Mark all as read
            </button>
          )}
        </div>
        {items.length ? (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => openOne(n)}
                  className={cn('block w-full border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent', !n.read && 'bg-primary/5')}
                >
                  {n.kind === 'mention' ? (
                    <>
                      <p className="text-xs">
                        <span className="font-semibold">{n.actor}</span> mentioned you on <span className="font-medium">“{n.task.title}”</span>
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
                    </>
                  ) : (
                    <p className="text-xs">
                      <span className="font-semibold">{n.actor}</span> added you to{' '}
                      {n.workspace ? (
                        <>
                          the workspace <span className="font-medium">“{n.workspace.name}”</span>
                        </>
                      ) : n.board ? (
                        <>
                          the board <span className="font-medium">“{n.board.name}”</span>
                        </>
                      ) : (
                        'something that’s since been deleted'
                      )}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {!n.read && <span className="mr-1 inline-block size-1.5 rounded-full bg-primary align-middle" />}
                    {formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true })}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            When someone @mentions you in a comment or adds you to a board, it shows up here.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
