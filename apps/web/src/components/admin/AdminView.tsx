import { ChartBar, EnvelopeSimple, HardDrives, UsersThree } from '@phosphor-icons/react'
import { useEffect } from 'react'
import { type AdminSection } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { SettingsLayout, type SettingsNavItem } from '@/components/settings/SettingsLayout'
import { AccountsSection } from './Accounts'
import { EmailSettings } from './EmailSettings'
import { OverviewSection } from './Overview'
import { StorageSettings } from './StorageSettings'

const SECTIONS: (SettingsNavItem & { id: AdminSection })[] = [
  { id: 'overview', label: 'Overview', icon: ChartBar, href: { page: 'admin' } },
  { id: 'accounts', label: 'Accounts', icon: UsersThree, href: { page: 'admin', section: 'accounts' } },
  { id: 'email', label: 'Email', icon: EnvelopeSimple, href: { page: 'admin', section: 'email' } },
  { id: 'storage', label: 'Storage', icon: HardDrives, href: { page: 'admin', section: 'storage' } },
]

/**
 * The platform console, for the people running Kanbanto. Admin rights are granted on the server
 * (`admin grant <email>`); people's boards aren't visible here.
 */
export function AdminView({ section = 'overview' }: { section?: AdminSection }) {
  const { user, refresh } = useAuth()
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  // Admin rights are granted on the server, so check again when the console is opened.
  useEffect(() => void refresh(), [refresh])
  useEffect(() => {
    document.title = `${current.label} · Platform console · Kanbanto`
  }, [current.label])

  if (!user?.isAdmin)
    return (
      <SettingsLayout title="Platform console" items={[]} current="">
        <p className="text-center text-sm text-muted-foreground">Only platform admins can see this page.</p>
      </SettingsLayout>
    )
  return (
    <SettingsLayout title="Platform console" items={SECTIONS} current={current.id}>
      {current.id === 'overview' && <OverviewSection />}
      {current.id === 'accounts' && <AccountsSection />}
      {current.id === 'email' && <EmailSettings />}
      {current.id === 'storage' && <StorageSettings />}
    </SettingsLayout>
  )
}
