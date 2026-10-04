import { Bell, CalendarDots, Code, EnvelopeSimple, HardDrives, Key, UserCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { PublicUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { currentSubscription } from '@/lib/push'
import type { AccountSection } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsLayout, type SettingsNavItem } from '@/components/settings/SettingsLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiTokensSection } from './ApiTokens'
import { CalendarSection } from './Calendar'
import { DesktopNotifications } from './DesktopNotifications'
import { AccountEmailSection } from './EmailSending'
import { AccountStorageSection } from './FileStorage'

const SECTIONS: (SettingsNavItem & { id: AccountSection })[] = [
  { id: 'profile', label: 'Profile', icon: UserCircle, href: { page: 'account' } },
  { id: 'password', label: 'Password', icon: Key, href: { page: 'account', section: 'password' } },
  { id: 'notifications', label: 'Notifications', icon: Bell, href: { page: 'account', section: 'notifications' } },
  { id: 'calendar', label: 'Calendar', icon: CalendarDots, href: { page: 'account', section: 'calendar' } },
  { id: 'email', label: 'Email sending', icon: EnvelopeSimple, href: { page: 'account', section: 'email' } },
  { id: 'storage', label: 'File storage', icon: HardDrives, href: { page: 'account', section: 'storage' } },
  { id: 'api', label: 'API & apps', icon: Code, href: { page: 'account', section: 'api' } },
]

/** Your account settings, laid out like the Platform console: a sidebar of sections, each on its own page. */
export function AccountView({ section = 'profile', problem }: { section?: AccountSection; problem?: string }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  useEffect(() => {
    document.title = `${current.label} · Account · Kanbanto`
  }, [current.label])
  return (
    <SettingsLayout title="Account settings" items={SECTIONS} current={current.id}>
      {current.id === 'profile' && <Profile />}
      {current.id === 'password' && <Password />}
      {current.id === 'notifications' && <Notifications />}
      {current.id === 'calendar' && <CalendarSection problem={problem} />}
      {current.id === 'email' && <AccountEmailSection />}
      {current.id === 'storage' && <AccountStorageSection />}
      {current.id === 'api' && <ApiTokensSection />}
    </SettingsLayout>
  )
}

function Profile() {
  const { user, setUser } = useAuth()
  const [name, setName] = useState(user?.name ?? '')
  if (!user) return null
  const changed = name.trim() && name.trim() !== user.name
  return (
    <div className="space-y-6">
      <PageTitle title="Profile" description="How you appear to others on boards and tasks." />
      <SettingsCard title="Your name">
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              setUser((await api<{ user: PublicUser }>('PATCH', '/auth/me', { name })).user)
              toast('Name saved')
            } catch (err) {
              toast.error(errorMessage(err))
            }
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" className="max-w-sm" />
          <Button type="submit" size="sm" disabled={!changed}>
            Save
          </Button>
        </form>
      </SettingsCard>
      <SettingsCard title="Email address" description="You sign in with it, and it’s where invites and summaries are sent.">
        <p className="text-sm">
          {user.email}{' '}
          {user.emailVerified && (
            <span className="ml-1 rounded bg-status-done/15 px-1.5 py-0.5 text-[11px] font-medium text-status-done">Confirmed</span>
          )}
        </p>
      </SettingsCard>
    </div>
  )
}

function Password() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  return (
    <div className="space-y-6">
      <PageTitle title="Password" />
      <SettingsCard title="Change your password" description="You’ll stay signed in here; your other devices will be signed out.">
        <form
          className="max-w-sm space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              // (This browser keeps its desktop notifications; the others are signed out and lose theirs.)
              const push = await currentSubscription().catch(() => null)
              await api('POST', '/auth/password', { current, next, ...(push && { pushEndpoint: push.endpoint }) })
              setCurrent('')
              setNext('')
              toast('Password changed. You’ve been signed out on your other devices.')
            } catch (err) {
              toast.error(errorMessage(err))
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">Current password</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-next">New password</Label>
            <Input
              id="pw-next"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          <Button type="submit" size="sm">
            Change password
          </Button>
        </form>
      </SettingsCard>
    </div>
  )
}

function Notifications() {
  const { user, setUser } = useAuth()
  if (!user) return null
  return (
    <div className="space-y-6">
      <PageTitle
        title="Notifications"
        description="Mentions and reminders show under the bell. Choose what’s emailed too, and when your morning is."
      />
      <SettingsCard
        title="Morning summary email"
        description="Around 8:00 your time: cards due today and overdue, reminders later today, and mentions you haven’t seen. Only when there’s something."
        action={
          <Switch
            checked={user.mentionEmails}
            aria-label="Morning summary email"
            onCheckedChange={(on) =>
              api<{ user: PublicUser }>('PATCH', '/auth/me', { mentionEmails: on }).then(
                (r) => {
                  setUser(r.user)
                  toast(on ? 'You’ll get a morning summary' : 'No more morning summaries')
                },
                (e) => toast.error(errorMessage(e)),
              )
            }
          />
        }
      >
        <p className="text-xs text-muted-foreground">{user.mentionEmails ? 'On.' : 'Off: mentions and reminders still show under the bell.'}</p>
      </SettingsCard>
      <TimeZoneCard />
      <DesktopNotifications />
      <SettingsCard
        title="Email me reminders"
        description="When a reminder on a card assigned to you goes off (or one you set on a card nobody is assigned to)."
        action={
          <Switch
            checked={user.reminderEmails}
            aria-label="Email me reminders"
            onCheckedChange={(on) =>
              api<{ user: PublicUser }>('PATCH', '/auth/me', { reminderEmails: on }).then(
                (r) => {
                  setUser(r.user)
                  toast(on ? 'Reminders will be emailed too' : 'Reminders only show under the bell')
                },
                (e) => toast.error(errorMessage(e)),
              )
            }
          />
        }
      >
        <p className="text-xs text-muted-foreground">
          {user.reminderEmails ? 'On: under the bell and by email.' : 'Off: reminders only show under the bell.'}
        </p>
      </SettingsCard>
    </div>
  )
}

/** Your time zone: when "morning" is for the summary, and "9:00" for reminders counted from a due day. */
function TimeZoneCard() {
  const { user, setUser } = useAuth()
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone')
    } catch {
      return [here]
    }
  }, [here])
  if (!user) return null
  const save = (timeZone: string) =>
    api<{ user: PublicUser }>('PATCH', '/auth/me', { timeZone }).then(
      (r) => {
        setUser(r.user)
        toast(`Time zone: ${timeZone.replace(/_/g, ' ')}`)
      },
      (e) => toast.error(errorMessage(e)),
    )
  const current = user.timeZone ?? here
  return (
    <SettingsCard title="Your time zone" description="When your morning summary goes out.">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={current}
          onChange={(e) => void save(e.target.value)}
          aria-label="Time zone"
          className="h-9 min-w-56 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          {(zones.includes(current) ? zones : [current, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        {current !== here && (
          <Button variant="outline" size="sm" onClick={() => void save(here)}>
            Use this computer’s ({here.replace(/_/g, ' ')})
          </Button>
        )}
      </div>
    </SettingsCard>
  )
}
