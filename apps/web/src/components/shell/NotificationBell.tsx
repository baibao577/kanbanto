import { Bell } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useState } from 'react'
import type { NotificationView } from '@kanbanto/model/api'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fetchNotifications, markRead, onNotificationsChanged, setRead, whereTo } from '@/data/notifications'
import { cn } from '@/lib/utils'
import { NotificationText } from './NotificationText'

/**
 * The bell: @mentions of you, comments and changes on the cards you follow (each with a way to stop following),
 * reactions to your comments, what
 * a board's rules told you (each with a way to stop that rule telling you), reminders, and boards or workspaces
 * someone added you to, newest first: the newest 30, with "See all" for the page of them all. Checked every minute
 * and when you come back to the tab. A line that has been read can be turned back to unread, to come back to.
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
    // (Something was marked read or unread, here or on the page of them all.)
    const off = onNotificationsChanged(refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      off()
    }
  }, [user, apply, refresh])

  if (!user) return null

  const openOne = (n: NotificationView) => {
    setOpen(false)
    if (!n.read) void markRead([n.id])
    const to = whereTo(n)
    if (to) navigate(to)
  }

  /** Stops following the card a line is about (and that line is done with). */
  const unfollow = (n: NotificationView & { kind: 'comment' | 'change' }) => {
    api('PUT', `/boards/${n.board.id}/tasks/${n.task.id}/follow`, { following: false }).then(
      () => {
        toast(`You no longer follow “${n.task.title}”.`)
        if (!n.read) void markRead([n.id])
      },
      (e) => toast.error(errorMessage(e)),
    )
  }

  /** Stops the rule behind a line telling you (it stays on for everyone else; Rules on the board switches it back). */
  const stopRule = (n: NotificationView & { kind: 'rule' }) => {
    api('PUT', `/boards/${n.board.id}/rules/${n.rule.id}/mute`, { muted: true }).then(
      () => {
        toast(`${n.rule.name ? `“${n.rule.name}”` : 'This rule'} no longer tells you. The board’s Rules button switches it back on.`)
        if (!n.read) void markRead([n.id])
      },
      (e) => toast.error(errorMessage(e)),
    )
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
            <button className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => void markRead()}>
              Mark all as read
            </button>
          )}
        </div>
        {items.length ? (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <li key={n.id} className={cn('group relative border-b last:border-0 hover:bg-accent', !n.read && 'bg-primary/5')}>
                <button onClick={() => openOne(n)} className="block w-full px-3 py-2.5 text-left">
                  <NotificationText n={n} />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {!n.read && (
                      <span
                        title={n.kept ? 'You kept this unread' : undefined}
                        className={cn('mr-1 inline-block size-1.5 rounded-full align-middle', n.kept ? 'ring-2 ring-primary' : 'bg-primary')}
                      />
                    )}
                    {formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true })}
                  </p>
                </button>
                {/* Read, and worth coming back to: unread again (where a line can be pointed at; the page has it for touch). */}
                {n.read && (
                  <button
                    onClick={() => void setRead(n.id, false).catch((e) => toast.error(errorMessage(e)))}
                    title="Keep this as unread, to come back to"
                    className="absolute top-2 right-3 hidden rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground [@media(hover:hover)]:group-hover:block"
                  >
                    Mark as unread
                  </button>
                )}
                {(n.kind === 'comment' || n.kind === 'change') && n.board.id && n.task.id && (
                  <button
                    onClick={() => unfollow(n)}
                    title="Stop being told about this card"
                    className="absolute right-3 bottom-2 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Unfollow
                  </button>
                )}
                {n.kind === 'rule' && n.board.id && n.rule.id && (
                  <button
                    onClick={() => stopRule(n)}
                    title="This rule stops telling you. It stays on for everyone else."
                    className="absolute right-3 bottom-2 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Stop telling me
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Mentions of you, news from the cards you follow, reactions to your comments, what your boards’ rules tell you, reminders and new boards
            show up here.
          </p>
        )}
        <a
          href={hrefFor({ page: 'notifications' })}
          onClick={() => setOpen(false)}
          className="block border-t px-3 py-2 text-center text-xs font-medium text-primary hover:bg-accent"
        >
          See all
        </a>
      </PopoverContent>
    </Popover>
  )
}
