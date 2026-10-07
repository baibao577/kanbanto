import { Bell, BookmarkSimple, CalendarDots, Code, EnvelopeSimple, HardDrives, Key, Tag, UserCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PublicUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { removePicture, savePicture, squarePicture } from '@/lib/picture'
import { currentSubscription } from '@/lib/push'
import type { AccountSection } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Avatar } from '@/components/common/bits'
import { FieldLibrary } from '@/components/fields/FieldLibrary'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsLayout, type SettingsNavItem } from '@/components/settings/SettingsLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { AddFromAnywhere } from './AddFromAnywhere'
import { ApiTokensSection } from './ApiTokens'
import { CalendarSection } from './Calendar'
import { DesktopNotifications } from './DesktopNotifications'
import { TelegramNews } from './TelegramNews'
import { AccountEmailSection } from './EmailSending'
import { AccountStorageSection } from './FileStorage'

const SECTIONS: (SettingsNavItem & { id: AccountSection })[] = [
  { id: 'profile', label: 'Profile', icon: UserCircle, href: { page: 'account' } },
  { id: 'password', label: 'Password', icon: Key, href: { page: 'account', section: 'password' } },
  { id: 'notifications', label: 'Notifications', icon: Bell, href: { page: 'account', section: 'notifications' } },
  { id: 'calendar', label: 'Calendar', icon: CalendarDots, href: { page: 'account', section: 'calendar' } },
  { id: 'fields', label: 'Fields', icon: Tag, href: { page: 'account', section: 'fields' } },
  { id: 'email', label: 'Email sending', icon: EnvelopeSimple, href: { page: 'account', section: 'email' } },
  { id: 'storage', label: 'File storage', icon: HardDrives, href: { page: 'account', section: 'storage' } },
  { id: 'api', label: 'API & apps', icon: Code, href: { page: 'account', section: 'api' } },
  { id: 'add', label: 'Add from anywhere', icon: BookmarkSimple, href: { page: 'account', section: 'add' } },
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
      {current.id === 'fields' && (
        <div>
          <PageTitle
            title="Fields"
            description="Extra things to fill in on cards, for your Personal boards. A workspace has its own, on the workspace’s page."
          />
          <FieldLibrary base="/fields" description="Add a field once here, then choose which boards use it, in each board’s settings under Fields." />
        </div>
      )}
      {current.id === 'email' && <AccountEmailSection />}
      {current.id === 'storage' && <AccountStorageSection />}
      {current.id === 'api' && <ApiTokensSection />}
      {current.id === 'add' && <AddFromAnywhere />}
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
      <Picture />
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

/** Your profile picture: choose one, see it in the circle, then save it. Without one you show as your initials. */
function Picture() {
  const { user, setUser } = useAuth()
  const input = useRef<HTMLInputElement>(null)
  // The picture chosen and not saved yet: what will be sent, and where the browser keeps it to show it.
  const [chosen, setChosen] = useState<{ picture: Blob; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => () => void (chosen && URL.revokeObjectURL(chosen.url)), [chosen])
  if (!user) return null

  const choose = async (file: File | undefined) => {
    if (!file) return
    try {
      const picture = await squarePicture(file)
      setChosen({ picture, url: URL.createObjectURL(picture) })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }
  const change = async (work: () => Promise<PublicUser>, done: string) => {
    setBusy(true)
    try {
      setUser(await work())
      setChosen(null)
      toast(done)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const pick = () => input.current?.click()

  return (
    <SettingsCard title="Picture" description="Shown in place of your initials on cards, comments and everywhere else you appear.">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar name={user.name} picture={chosen?.url ?? user.picture} className="size-16 text-xl" />
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <div className="flex flex-wrap gap-2">
            {chosen ? (
              <>
                <Button key="save" size="sm" disabled={busy} onClick={() => change(() => savePicture(chosen.picture), 'Picture saved')}>
                  Save
                </Button>
                <Button key="cancel" size="sm" variant="ghost" disabled={busy} onClick={() => setChosen(null)}>
                  Cancel
                </Button>
              </>
            ) : user.picture ? (
              <>
                <Button key="change" size="sm" variant="outline" disabled={busy} onClick={pick}>
                  Change
                </Button>
                <Button
                  key="remove"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => change(removePicture, 'Picture removed')}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={pick}>
                Choose a picture
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {chosen
              ? 'This is how it will look. It isn’t saved yet.'
              : user.picture
                ? 'Others see it wherever your name appears.'
                : 'A JPG, PNG or WebP. It’s cut to a square from the middle.'}
          </p>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        aria-label="Choose a picture"
        onChange={(e) => {
          void choose(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </SettingsCard>
  )
}

function Password() {
  const { user, setUser } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  if (!user) return null
  // Someone who only ever signed in with Google has no password yet: they add one, with no current one to give.
  const adding = !user.hasPassword
  return (
    <div className="space-y-6">
      <PageTitle title="Password" />
      <SettingsCard
        title={adding ? 'Add a password' : 'Change your password'}
        description={
          adding
            ? 'You sign in with Google. With a password you can also sign in with your email address.'
            : 'You’ll stay signed in here; your other devices will be signed out.'
        }
      >
        <form
          className="max-w-sm space-y-3"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              // (This browser keeps its desktop notifications; the others are signed out and lose theirs.)
              const push = await currentSubscription().catch(() => null)
              await api('POST', '/auth/password', { ...(!adding && { current }), next, ...(push && { pushEndpoint: push.endpoint }) })
              setCurrent('')
              setNext('')
              setUser({ ...user, hasPassword: true })
              toast(
                adding
                  ? 'Password added. You’ve been signed out on your other devices.'
                  : 'Password changed. You’ve been signed out on your other devices.',
              )
            } catch (err) {
              toast.error(errorMessage(err))
            }
          }}
        >
          {!adding && (
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
          )}
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
            {adding ? 'Add password' : 'Change password'}
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
        description="Mentions, reminders and news from the cards you follow show under the bell. Choose what’s emailed too, and when your morning is."
      />
      <SettingsCard
        title="Morning summary email"
        description="Around 8:00 your time: cards due today and overdue, reminders later today, and mentions and news from the cards you follow that you haven’t seen. Only when there’s something."
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
        <p className="text-xs text-muted-foreground">
          {user.mentionEmails ? 'On.' : 'Off: mentions, reminders and news from the cards you follow still show under the bell.'}
        </p>
      </SettingsCard>
      <TimeZoneCard />
      <DesktopNotifications />
      <TelegramNews />
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
