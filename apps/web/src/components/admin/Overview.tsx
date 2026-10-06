import { CaretRight, EnvelopeSimple, HardDrives, UsersThree } from '@phosphor-icons/react'
import { type ReactNode } from 'react'
import type { AdminSettings, PlatformEmail, PlatformStats, PlatformStorage } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { hrefFor, type AdminSection } from '@/app/router'
import { formatSize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { PageTitle } from '@/components/settings/SettingsCard'
import { useLoaded } from '@/data/useLoaded'

type Data = { stats: PlatformStats; signup: string; email: PlatformEmail; storage: PlatformStorage }
const fetchOverview = () =>
  Promise.all([
    api<PlatformStats>('GET', '/admin/stats'),
    api<AdminSettings>('GET', '/admin/settings'),
    api<PlatformEmail>('GET', '/admin/email'),
    api<PlatformStorage>('GET', '/admin/storage'),
  ]).then(([stats, s, email, storage]): Data => ({
    stats,
    signup: !s.openSignup ? 'Invite only' : s.signupGoogleOnly ? 'Open, with Google only' : 'Open to anyone',
    email,
    storage,
  }))

/** Platform console → Overview: totals, and how each part is set up (with a link to change it). */
export function OverviewSection() {
  const [d] = useLoaded(fetchOverview)
  if (!d) return null
  const { stats, email, storage } = d
  const emailOk = email.sender && email.sender.working
  return (
    <div className="space-y-6">
      <PageTitle title="Overview" description="How Kanbanto is doing, and how it’s set up." />
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Accounts"
          value={stats.users}
          note={stats.activeUsers < stats.users ? `${stats.users - stats.activeUsers} turned off` : undefined}
        />
        <Stat label="New this week" value={stats.newUsers} />
        <Stat label="Boards" value={stats.boards} />
        <Stat label="Tasks" value={stats.tasks} />
      </section>
      <section className="grid gap-3 md:grid-cols-3">
        <StatusCard section="accounts" icon={<UsersThree />} title="Sign-up" state={d.signup} tone="ok" />
        <StatusCard
          section="email"
          icon={<EnvelopeSimple />}
          title="Email"
          state={!email.sender ? 'Not set up' : emailOk ? `Sending from ${email.sender.from.replace(/^.*</, '').replace('>', '')}` : 'Not sending'}
          detail={email.sender ? `${email.usage.today} today · ${email.usage.month.toLocaleString()} this month` : 'Password resets go through you'}
          tone={!email.sender ? 'off' : emailOk ? 'ok' : 'bad'}
        />
        <StatusCard
          section="storage"
          icon={<HardDrives />}
          title="Storage"
          state={storage.bucket ? `Bucket “${storage.bucket.bucket}”` : 'This server’s disk'}
          detail={`${storage.usage.files.toLocaleString()} files · ${formatSize(storage.usage.bytes)}`}
          tone={storage.bucket?.lastError ? 'bad' : 'ok'}
        />
      </section>
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  )
}

function StatusCard(props: { section: AdminSection; icon: ReactNode; title: string; state: string; detail?: string; tone: 'ok' | 'off' | 'bad' }) {
  return (
    <a
      href={hrefFor({ page: 'admin', section: props.section })}
      className="group flex items-start gap-3 rounded-xl border bg-card p-4 hover:bg-accent/50"
    >
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-5">{props.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{props.title}</p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm font-medium">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              props.tone === 'ok' ? 'bg-status-done' : props.tone === 'bad' ? 'bg-destructive' : 'bg-muted-foreground/40',
            )}
          />
          <span className="truncate">{props.state}</span>
        </p>
        {props.detail && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{props.detail}</p>}
      </div>
      <CaretRight className="mt-1 size-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
    </a>
  )
}
