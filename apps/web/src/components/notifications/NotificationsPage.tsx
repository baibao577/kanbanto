import { ArrowLeft, Bell, DotsThree } from '@phosphor-icons/react'
import { format, parseISO } from 'date-fns'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { NOTIFICATIONS_KEPT_MONTHS, type NotificationView } from '@kanbanto/model/api'
import { periodOf } from '@kanbanto/model/search'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate, type NotificationsRoute } from '@/app/router'
import { LogoMark } from '@/components/common/Logo'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { NotificationText } from '@/components/shell/NotificationText'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchNotifications, markRead, onNotificationsChanged, setRead, whereTo } from '@/data/notifications'
import { useBoards } from '@/data/useBoards'
import { cn } from '@/lib/utils'
import { useNow } from '@/lib/useNow'
import { whenOf } from './when'

const PAGE = 50
const ALL = 'all'

/**
 * Every notification you were told, newest first, under the day it came: what the bell shows 30 of. Narrowed to the
 * unread, to mentions of you, or to one board. A line that has been read can be turned back to unread, to come back
 * to: it then counts under the bell again and stays until it is opened or marked read ("Mark all as read" leaves it).
 * Read lines are kept for a few months; unread ones until they are dealt with.
 */
export function NotificationsPage({ route }: { route: NotificationsRoute }) {
  const { boards } = useBoards()
  const [items, setItems] = useState<NotificationView[] | null>(null)
  const [unread, setUnread] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow()
  const { show, board } = route
  const query = useMemo(() => ({ unread: show === 'unread', mentions: show === 'mentions', board }), [show, board])

  /** How many lines are shown: what is asked for again when something changes, so the list keeps its length. */
  const shown = useRef(PAGE)
  const load = useCallback(
    (limit = PAGE) =>
      fetchNotifications({ ...query, limit: Math.min(100, Math.max(PAGE, limit)) }).then(
        (r) => {
          setItems(r.notifications)
          setUnread(r.unread)
          setNext(r.next)
          setError(null)
        },
        (e) => setError(errorMessage(e)),
      ),
    [query],
  )
  // (Asked for again from the start when what is asked for changes: the page is made anew then, see App.tsx.)
  useEffect(() => void load(), [load])
  // Kept up to date: when something is marked read or unread (here or under the bell), on coming back to the tab,
  // and every minute, as the bell is.
  useEffect(() => {
    const again = () => void load(shown.current)
    const off = onNotificationsChanged(again)
    const timer = setInterval(again, 60_000)
    window.addEventListener('focus', again)
    return () => {
      off()
      clearInterval(timer)
      window.removeEventListener('focus', again)
    }
  }, [load])

  const earlier = () => {
    if (!next || busy) return
    setBusy(true)
    fetchNotifications({ ...query, limit: PAGE, before: next })
      .then(
        (r) => {
          setItems((had) => [...(had ?? []), ...r.notifications])
          setNext(r.next)
          shown.current += r.notifications.length
        },
        (e) => toast.error(errorMessage(e)),
      )
      .finally(() => setBusy(false))
  }

  const groups = useMemo(() => {
    const out: { title: string; lines: NotificationView[] }[] = []
    for (const n of items ?? []) {
      const title = periodOf(Date.parse(n.createdAt), new Date(now))
      if (out.at(-1)?.title === title) out.at(-1)!.lines.push(n)
      else out.push({ title, lines: [n] })
    }
    return out
  }, [items, now])

  const open = (n: NotificationView) => {
    if (!n.read) void markRead([n.id])
    const to = whereTo(n)
    if (to) navigate(to)
  }
  const failed = (e: unknown) => toast.error(errorMessage(e))
  /** Stops following the card a line is about. */
  const unfollow = (n: NotificationView & { kind: 'comment' | 'change' }) =>
    api('PUT', `/boards/${n.board.id}/tasks/${n.task.id}/follow`, { following: false }).then(() => {
      toast(`You no longer follow “${n.task.title}”.`)
      if (!n.read) void markRead([n.id])
    }, failed)
  /** Stops the rule behind a line telling you (it stays on for everyone else). */
  const stopRule = (n: NotificationView & { kind: 'rule' }) =>
    api('PUT', `/boards/${n.board.id}/rules/${n.rule.id}/mute`, { muted: true }).then(() => {
      toast(`${n.rule.name ? `“${n.rule.name}”` : 'This rule'} no longer tells you. The board’s Rules button switches it back on.`)
      if (!n.read) void markRead([n.id])
    }, failed)

  const tab = (to: NotificationsRoute['show'], label: string, count?: number) => (
    <a
      href={hrefFor({ page: 'notifications', show: to, board })}
      aria-current={show === to ? 'page' : undefined}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs whitespace-nowrap',
        show === to ? 'bg-background font-semibold shadow-xs' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {!!count && <span className="ml-1 tabular-nums">{count}</span>}
    </a>
  )
  const nothing =
    show === 'unread'
      ? 'Nothing is unread.'
      : show === 'mentions'
        ? 'Nobody has mentioned you lately.'
        : board
          ? 'Nothing from this board lately.'
          : 'Mentions of you, news from the cards you follow, what your boards’ rules tell you, reminders and new boards will be listed here.'

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <a href={hrefFor({ page: 'home' })} className="grid size-8 place-items-center rounded-md hover:bg-accent" aria-label="Your boards">
          <LogoMark className="size-7" title="Your boards" />
        </a>
        <a href={hrefFor({ page: 'home' })} className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5 shrink-0" /> <span className="truncate">Boards</span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <AccountMenu />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Bell className="size-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold">Notifications</h1>
              <p className="text-xs text-muted-foreground">
                What you were told in the last {NOTIFICATIONS_KEPT_MONTHS} months, and whatever is still unread.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Which notifications" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {tab(undefined, 'All')}
              {tab('unread', 'Unread', unread)}
              {tab('mentions', 'Mentions')}
            </nav>
            <Select
              value={board ?? ALL}
              onValueChange={(v) => navigate({ page: 'notifications', show, board: v === ALL ? undefined : v }, { replace: true })}
            >
              <SelectTrigger size="sm" aria-label="Board" className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All boards</SelectItem>
                {(boards ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
                {board && boards && !boards.some((b) => b.id === board) && <SelectItem value={board}>A board you can no longer open</SelectItem>}
              </SelectContent>
            </Select>
            {unread > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-8 text-xs text-muted-foreground"
                title="Marks what is new as read. Lines you kept as unread yourself stay."
                onClick={() => void markRead().catch(failed)}
              >
                Mark all as read
              </Button>
            )}
          </div>

          {error ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{error}</p>
          ) : !items ? null : !items.length ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{nothing}</p>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              {groups.map((g, gi) => (
                <section key={`${g.title}${gi}`} aria-label={g.title}>
                  <h2
                    className={cn(
                      'bg-muted/60 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase',
                      gi > 0 && 'border-t',
                    )}
                  >
                    {g.title}
                  </h2>
                  <ul>
                    {g.lines.map((n) => (
                      <li key={n.id} className={cn('group relative flex items-start border-t hover:bg-accent/60', !n.read && 'bg-primary/5')}>
                        <button onClick={() => open(n)} className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pr-2 pl-4 text-left">
                          <span
                            aria-label={n.read ? undefined : n.kept ? 'Kept as unread' : 'Unread'}
                            title={n.kept ? 'You kept this as unread' : undefined}
                            className={cn(
                              'mt-1.5 size-2 shrink-0 rounded-full',
                              n.read ? 'bg-transparent' : n.kept ? 'ring-2 ring-primary ring-inset' : 'bg-primary',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <NotificationText n={n} roomy />
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-1 py-2 pr-2">
                          {/* (Where a line can be pointed at, the one thing most often wanted is a click away.) */}
                          <button
                            onClick={() => void setRead(n.id, !n.read).catch(failed)}
                            className="hidden rounded border bg-background px-1.5 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground hover:text-foreground [@media(hover:hover)]:group-hover:block"
                          >
                            {n.read ? 'Mark as unread' : 'Mark as read'}
                          </button>
                          <time
                            dateTime={n.createdAt}
                            title={format(parseISO(n.createdAt), 'PPpp')}
                            className="px-1 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
                          >
                            {whenOf(parseISO(n.createdAt), new Date(now))}
                          </time>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                aria-label="More for this notification"
                                className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                              >
                                <DotsThree className="size-4" weight="bold" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuItem onSelect={() => void setRead(n.id, !n.read).catch(failed)}>
                                {n.read ? 'Mark as unread' : 'Mark as read'}
                              </DropdownMenuItem>
                              {(n.kind === 'comment' || n.kind === 'change') && n.board.id && n.task.id && (
                                <DropdownMenuItem onSelect={() => void unfollow(n)}>Stop following this card</DropdownMenuItem>
                              )}
                              {n.kind === 'rule' && n.board.id && n.rule.id && (
                                <DropdownMenuItem onSelect={() => void stopRule(n)}>Stop this rule telling me</DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {next && (
                <button
                  onClick={earlier}
                  disabled={busy}
                  className="block w-full border-t px-4 py-2.5 text-center text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {busy ? 'Fetching…' : 'Show earlier ones'}
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
