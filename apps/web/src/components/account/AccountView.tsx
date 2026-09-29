import { Bell, Code, EnvelopeSimple, HardDrives, Key, UserCircle } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PublicUser } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import type { AccountSection } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsLayout, type SettingsNavItem } from '@/components/settings/SettingsLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ApiTokensSection } from './ApiTokens'
import { AccountEmailSection } from './EmailSending'
import { AccountStorageSection } from './FileStorage'

const SECTIONS: (SettingsNavItem & { id: AccountSection })[] = [
  { id: 'profile', label: 'Profile', icon: UserCircle, href: { page: 'account' } },
  { id: 'password', label: 'Password', icon: Key, href: { page: 'account', section: 'password' } },
  { id: 'notifications', label: 'Notifications', icon: Bell, href: { page: 'account', section: 'notifications' } },
  { id: 'email', label: 'Email sending', icon: EnvelopeSimple, href: { page: 'account', section: 'email' } },
  { id: 'storage', label: 'File storage', icon: HardDrives, href: { page: 'account', section: 'storage' } },
  { id: 'api', label: 'API & apps', icon: Code, href: { page: 'account', section: 'api' } },
]

/** Your account settings, laid out like the Platform console: a sidebar of sections, each on its own page. */
export function AccountView({ section = 'profile' }: { section?: AccountSection }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  useEffect(() => {
    document.title = `${current.label} · Account · Kanbanto`
  }, [current.label])
  return (
    <SettingsLayout title="Account settings" items={SECTIONS} current={current.id}>
      {current.id === 'profile' && <Profile />}
      {current.id === 'password' && <Password />}
      {current.id === 'notifications' && <Notifications />}
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
              await api('POST', '/auth/password', { current, next })
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
      <PageTitle title="Notifications" description="When someone @mentions you in a comment, it shows under the bell." />
      <SettingsCard
        title="Email me when I’m mentioned"
        description="At most one summary a day, only for mentions you haven’t seen in the app."
        action={
          <Switch
            checked={user.mentionEmails}
            aria-label="Email me when I’m mentioned"
            onCheckedChange={(on) =>
              api<{ user: PublicUser }>('PATCH', '/auth/me', { mentionEmails: on }).then(
                (r) => {
                  setUser(r.user)
                  toast(on ? 'You’ll get a daily summary of mentions' : 'No more mention emails')
                },
                (e) => toast.error(errorMessage(e)),
              )
            }
          />
        }
      >
        <p className="text-xs text-muted-foreground">{user.mentionEmails ? 'On: a daily summary.' : 'Off: mentions only show under the bell.'}</p>
      </SettingsCard>
    </div>
  )
}
