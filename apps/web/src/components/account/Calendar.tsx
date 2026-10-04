import { Copy, GoogleLogo, LinkSimple } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { AccountCalendar } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { hrefFor } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useLoaded } from '@/data/useLoaded'

const fetchCalendar = () => api<AccountCalendar>('GET', '/account/calendar')

/** Why connecting Google Calendar didn't work (Google sends people back with ?problem=…, see the server's routes/calendar.ts). */
const PROBLEMS: Record<string, string> = {
  denied: 'Google Calendar wasn’t connected: it wasn’t allowed on Google’s page.',
  permission: 'Google Calendar wasn’t connected: the calendar box on Google’s page has to stay ticked. Connect again and leave it ticked.',
  expired: 'That took too long, or was started in another browser. Connect Google Calendar again.',
  signin: 'Sign in, then connect Google Calendar again.',
  off: 'Google Calendar isn’t set up on this site.',
  setup:
    'Google Calendar isn’t set up correctly on this site: Google doesn’t accept the site’s client ID and secret. A platform admin can enter them again (Platform console → Integrations).',
  failed: 'Google Calendar couldn’t be connected. Try again in a moment.',
}

const ago = (iso: string) => formatDistanceToNow(parseISO(iso), { addSuffix: true })

/** "Turned off on this site", with the way to turn it on for a platform admin. */
function NeedsAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return (
    <p className="text-sm text-muted-foreground">
      {children}
      {user?.isAdmin ? (
        <>
          {' '}
          (you can:{' '}
          <a href={hrefFor({ page: 'admin', section: 'integrations' })} className="font-medium text-primary hover:underline">
            Platform console → Integrations
          </a>
          ).
        </>
      ) : (
        '.'
      )}
    </p>
  )
}

/**
 * Account settings → Calendar: your cards' due dates and reminders in the calendar you already use. Connect Google
 * Calendar (kept up to date within seconds), or make a private link that any calendar app can subscribe to; and choose
 * which boards are in it.
 */
export function CalendarSection({ problem }: { problem?: string }) {
  const [loaded, load] = useLoaded(fetchCalendar)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)

  // Back from Google without a connection: say why, once, and tidy the address.
  useEffect(() => {
    if (!problem) return
    toast.error(PROBLEMS[problem] ?? PROBLEMS.failed, { id: 'calendar-problem', duration: 10_000 })
    history.replaceState(null, '', hrefFor({ page: 'account', section: 'calendar' }))
  }, [problem])

  // Just connected: the calendar is being filled. Look again shortly, for "updated a few seconds ago".
  const filling = !!loaded?.google && !loaded.google.lastSyncedAt && !loaded.google.reconnect && !loaded.google.problem
  useEffect(() => {
    if (!filling) return
    const timer = setTimeout(() => void load(), 4000)
    return () => clearTimeout(timer)
  }, [filling, loaded, load])

  if (!loaded) return <PageTitle title="Calendar" />
  const { google, link } = loaded

  const change = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run()
      if (done) toast(done)
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const connect = async () => {
    setBusy(true)
    try {
      location.href = (await api<{ url: string }>('POST', '/account/calendar/google/start')).url
    } catch (e) {
      setBusy(false)
      toast.error(errorMessage(e))
    }
  }

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link.url)
      toast('Link copied')
    } catch {
      toast.error('Couldn’t copy. Select it and copy it yourself.')
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="Calendar"
        description="See your cards in the calendar you already use: the cards assigned to you and, on boards only you are on, the cards assigned to nobody. A due date is an event, and a reminder is an alert on it or a short event at its own time. Changes go one way, from Kanbanto to your calendar."
      />

      <SettingsCard
        title="Google Calendar"
        description="Kanbanto adds a calendar of its own to your Google account and keeps it up to date within seconds. It can’t see or change your other calendars."
      >
        {google ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 basis-52">
                <span className="block truncate text-sm font-medium">Connected{google.email ? ` as ${google.email}` : ''}</span>
                <span className="block text-xs text-muted-foreground">
                  {google.reconnect
                    ? 'Not updating.'
                    : google.lastSyncedAt
                      ? `Updated ${ago(google.lastSyncedAt)}.`
                      : loaded.googleEnabled
                        ? 'Filling your calendar…'
                        : 'Not updating: Google Calendar isn’t set up on this site any more.'}
                </span>
              </span>
              {google.reconnect && (
                <Button size="sm" disabled={busy || !loaded.googleEnabled} onClick={() => void connect()}>
                  <GoogleLogo /> Connect again
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setConfirm({
                    title: 'Disconnect Google Calendar?',
                    description: 'The calendar Kanbanto made is removed from your Google account, with its events. Your cards aren’t changed.',
                    confirmLabel: 'Disconnect',
                    destructive: true,
                    onConfirm: () => void change(() => api('DELETE', '/account/calendar/google'), 'Google Calendar disconnected'),
                  })
                }
              >
                Disconnect
              </Button>
            </div>
            {google.problem && <p className="text-xs text-destructive">Last problem: {google.problem}</p>}
          </>
        ) : loaded.googleEnabled ? (
          <Button disabled={busy} onClick={() => void connect()}>
            <GoogleLogo /> Connect Google Calendar
          </Button>
        ) : (
          <NeedsAdmin>Google Calendar isn’t set up on this site. A platform admin can set it up</NeedsAdmin>
        )}
      </SettingsCard>

      <SettingsCard
        title="Calendar link"
        description="A private address for Apple Calendar, Outlook and other calendar apps: add it there as a calendar to subscribe to. They look again about every hour; Google only a few times a day, so for Google connect it above."
      >
        {link ? (
          <>
            <div className="flex items-center gap-2">
              <Input readOnly value={link.url} onFocus={(e) => e.target.select()} className="h-8 font-mono text-xs" aria-label="Your calendar link" />
              <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy()}>
                <Copy /> Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {loaded.linksEnabled
                ? `Anyone who has this link can see your cards’ titles and dates, so keep it to yourself. Made ${ago(link.createdAt)}.`
                : 'Calendar links are turned off on this site, so this link doesn’t work for now.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!loaded.linksEnabled}
                onClick={() =>
                  setConfirm({
                    title: 'Make a new link?',
                    description: 'The old link stops working at once: calendars that use it stop updating until you give them the new one.',
                    confirmLabel: 'Make a new link',
                    onConfirm: () => void change(() => api('PUT', '/account/calendar/link'), 'New link made. The old one no longer works.'),
                  })
                }
              >
                Make a new link
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setConfirm({
                    title: 'Turn off your calendar link?',
                    description: 'Calendars that use it stop updating. You can make a new link later.',
                    confirmLabel: 'Turn off',
                    destructive: true,
                    onConfirm: () => void change(() => api('DELETE', '/account/calendar/link'), 'Calendar link turned off'),
                  })
                }
              >
                Turn off
              </Button>
            </div>
          </>
        ) : loaded.linksEnabled ? (
          <Button variant="outline" onClick={() => void change(() => api('PUT', '/account/calendar/link'))}>
            <LinkSimple /> Make a link
          </Button>
        ) : (
          <NeedsAdmin>Calendar links are turned off on this site. A platform admin can turn them on</NeedsAdmin>
        )}
      </SettingsCard>

      <SettingsCard title="Boards in your calendar" description="Turn a board off to leave its cards out, in Google Calendar and in your link.">
        {loaded.boards.length ? (
          <ul className="divide-y">
            {loaded.boards.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <label htmlFor={`calendar-board-${b.id}`} className="min-w-0 flex-1 truncate text-sm">
                  {b.name}
                </label>
                <Switch
                  id={`calendar-board-${b.id}`}
                  checked={!b.off}
                  onCheckedChange={(on) => void change(() => api('PUT', `/account/calendar/boards/${encodeURIComponent(b.id)}`, { off: !on }))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No boards yet.</p>
        )}
      </SettingsCard>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
