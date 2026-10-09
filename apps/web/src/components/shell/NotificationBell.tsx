import { Bell } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useState } from 'react'
import type { NotificationView } from '@kanbanto/model/api'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api/client'
import { navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** "Dana Reyes", "Dana Reyes and Priya Nair", "Dana Reyes, Priya Nair and 2 others" */
const people = (names: string[]) =>
  !names.length
    ? 'Someone'
    : names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length === 3 ? 'other' : 'others'}`

const fetchNotifications = () => api<{ notifications: NotificationView[]; unread: number }>('GET', '/notifications')

/**
 * The bell: @mentions of you, comments and changes on the cards you follow (each with a way to stop following),
 * reactions to your comments, what
 * a board's rules told you (each with a way to stop that rule telling you), reminders, and boards or workspaces
 * someone added you to, newest first. Checked every minute and when you come back
 * to the tab.
 */
/** The words of a description a comment is about, quoted over what the comment says. */
function About({ words }: { words?: string }) {
  if (!words) return null
  return <p className="mt-0.5 line-clamp-1 border-l-2 border-amber-400/70 pl-1.5 text-xs text-muted-foreground italic">{words}</p>
}

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
    if (n.kind === 'added') {
      if (n.board) navigate({ page: 'board', id: n.board.id })
      else if (n.workspace) navigate({ page: 'workspace', id: n.workspace.id })
    } else if (n.board.id) {
      // (A comment about words of a description opens at those words, on its full page.)
      const thread = 'thread' in n && n.task.id ? n.thread : undefined
      navigate({ page: 'board', id: n.board.id, ...(n.task.id && { task: n.task.id }), ...(thread && { full: true, note: thread }) })
    }
  }

  /** Stops following the card a line is about (and that line is done with). */
  const unfollow = (n: NotificationView & { kind: 'comment' | 'change' }) => {
    api('PUT', `/boards/${n.board.id}/tasks/${n.task.id}/follow`, { following: false }).then(
      () => {
        toast(`You no longer follow “${n.task.title}”.`)
        if (!n.read) void api('POST', '/notifications/read', { ids: [n.id] }).then(refresh)
      },
      (e) => toast.error(errorMessage(e)),
    )
  }

  /** Stops the rule behind a line telling you (it stays on for everyone else; Rules on the board switches it back). */
  const stopRule = (n: NotificationView & { kind: 'rule' }) => {
    api('PUT', `/boards/${n.board.id}/rules/${n.rule.id}/mute`, { muted: true }).then(
      () => {
        toast(`${n.rule.name ? `“${n.rule.name}”` : 'This rule'} no longer tells you. The board’s Rules button switches it back on.`)
        if (!n.read) void api('POST', '/notifications/read', { ids: [n.id] }).then(refresh)
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
              <li key={n.id} className={cn('relative border-b last:border-0 hover:bg-accent', !n.read && 'bg-primary/5')}>
                <button onClick={() => openOne(n)} className="block w-full px-3 py-2.5 text-left">
                  {n.kind === 'mention' ? (
                    <>
                      <p className="text-xs">
                        <span className="font-semibold">{n.actor}</span> mentioned you {n.where === 'description' ? 'in the description of' : 'on'}{' '}
                        <span className="font-medium">“{n.task.title}”</span>
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                      <About words={n.about} />
                      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
                    </>
                  ) : n.kind === 'comment' ? (
                    <>
                      <p className="text-xs">
                        <span className="font-semibold">{n.actor}</span> commented on <span className="font-medium">“{n.task.title}”</span>
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                      <About words={n.about} />
                      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
                    </>
                  ) : n.kind === 'resolved' ? (
                    <>
                      <p className="text-xs">
                        <span className="font-semibold">{n.actor}</span> resolved your comment on{' '}
                        <span className="font-medium">“{n.task.title}”</span>
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                      <About words={n.about} />
                      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
                    </>
                  ) : n.kind === 'change' ? (
                    n.changes.length === 1 ? (
                      <p className="text-xs">
                        <span className="font-semibold">{n.actor}</span> {n.changes[0]}
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                    ) : (
                      <>
                        <p className="text-xs">
                          <span className="font-semibold">{n.actor}</span> {n.changes.length ? `made ${n.changes.length} changes to` : 'changed'}{' '}
                          <span className="font-medium">“{n.task.title}”</span>
                          <span className="text-muted-foreground"> · {n.board.name}</span>
                        </p>
                        {n.changes.length > 0 && (
                          <ul className="mt-0.5 line-clamp-3 list-inside list-disc text-xs text-muted-foreground">
                            {n.changes.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    )
                  ) : n.kind === 'reaction' ? (
                    <>
                      <p className="text-xs">
                        <span className="font-semibold">{people(n.people)}</span> reacted {n.emoji.join(' ')} to your comment on{' '}
                        <span className="font-medium">“{n.task.title}”</span>
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
                    </>
                  ) : n.kind === 'rule' ? (
                    <>
                      <p className="text-xs">
                        <span className="font-medium">“{n.cards[0]?.title ?? n.task.title}”</span>
                        {n.cards.length - 1 + n.more > 0 && ` and ${n.cards.length - 1 + n.more} more`} {n.moment || 'was the subject of a rule'}
                        <span className="text-muted-foreground"> · {n.board.name}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        By {n.actor}
                        {n.rule.name && ` · Rule: ${n.rule.name}`}
                      </p>
                      {n.cards.length > 1 && (
                        <ul className="mt-0.5 line-clamp-3 list-inside list-disc text-xs text-muted-foreground">
                          {n.cards.slice(1).map((c) => (
                            <li key={c.id}>{c.title}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : n.kind === 'reminder' ? (
                    <p className="text-xs">
                      ⏰ Reminder: <span className="font-medium">“{n.task.title}”</span>
                      <span className="text-muted-foreground">
                        {' '}
                        · {n.board.name}
                        {n.actor && ` · set by ${n.actor}`}
                      </span>
                    </p>
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
      </PopoverContent>
    </Popover>
  )
}
