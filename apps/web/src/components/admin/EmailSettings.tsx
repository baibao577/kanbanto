import { PaperPlaneTilt, Warning } from '@phosphor-icons/react'
import { hrefFor } from '@/app/router'
import { useState } from 'react'
import { toast } from 'sonner'
import { EMAIL_KIND_LABELS, type EmailSender, type PlatformEmail } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useAuth } from '@/app/use-auth'
import { EmailKeyForm } from '@/components/email/EmailKeyForm'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useLoaded } from '@/data/useLoaded'

type Kind = keyof typeof EMAIL_KIND_LABELS
type Settings = PlatformEmail['settings']

const fetchEmail = () => api<PlatformEmail>('GET', '/admin/email')

/** Platform console → Email: the site's key, how much of the budget is used, limits, branding and previews. */
export function EmailSettings() {
  const { user, refresh } = useAuth()
  const [info, reload] = useLoaded(fetchEmail)

  if (!info || !user) return null
  const brandVersion = JSON.stringify([info.settings.brandName, info.settings.brandColor, info.settings.footer])
  return (
    <div className="space-y-6">
      <PageTitle
        title="Email"
        description="Used for confirming new accounts, password resets, board invites and the daily mention summary. Until it’s set up, people share boards with links and codes, and password resets go through you."
      />
      {info.printedOnly && (
        <div role="alert" className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <Warning weight="fill" className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <p className="font-medium">Emails are printed in the server’s terminal, not sent</p>
            <p className="text-xs text-muted-foreground">
              The server was started with <code className="font-mono">MAIL_TRANSPORT=log</code> (a development setting, usually in{' '}
              <code className="font-mono">apps/server/.env</code>). The settings below are saved, but nothing reaches anyone’s inbox until you remove
              that line and restart the server.
            </p>
          </div>
        </div>
      )}
      <SettingsCard title="Sending" description="How emails go out, and the address they come from.">
        <EmailKeyForm
          sender={info.sender}
          encryptionReady={info.encryptionReady}
          testRecipient={user.email}
          fromPlaceholder="Kanbanto <noreply@yourdomain.com>"
          providers={['resend', 'smtp']}
          onSave={async (fields) => {
            await api<EmailSender>('PUT', '/admin/email/sender', fields)
            toast('Saved. A test email is on its way to you.')
            await reload()
            await refresh() // sign-up now asks new people to confirm their email
          }}
          onRemove={async () => {
            await api('DELETE', '/admin/email/sender')
            toast('The site no longer sends email.')
            await reload()
            await refresh()
          }}
        />
        {info.sender && <Usage info={info} />}
        {info.sender && info.unconfirmed > 0 && <Unconfirmed count={info.unconfirmed} />}
      </SettingsCard>
      {info.sender && (
        <SettingsCard
          title="Limits"
          description={
            info.sender.provider === 'resend'
              ? 'Keep these under your Resend plan (the free plan is around 100 a day and 3,000 a month). Leave a box empty for no limit.'
              : 'Optional with your own mail server: set them if it has a sending limit. Leave a box empty for no limit.'
          }
        >
          <Limits key={`limits-${JSON.stringify(info.settings)}`} settings={info.settings} onSaved={reload} />
        </SettingsCard>
      )}
      <SettingsCard title="How emails look" description="Every email uses one layout with your name, colour and footer. The wording is fixed.">
        <Branding key={`brand-${JSON.stringify(info.settings)}`} settings={info.settings} onSaved={reload} />
      </SettingsCard>
      <SettingsCard title="Preview" description="Each email as people will get it, with the saved branding.">
        <Previews canSend={!!info.sender} version={brandVersion} />
      </SettingsCard>
    </div>
  )
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : limit ? Math.min(100, Math.round((used / limit) * 100)) : 100
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()}
          {limit === null ? ' · no limit' : ` of ${limit.toLocaleString()}`}
        </span>
      </div>
      {limit !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
          <div className={cn('h-full rounded-full', pct >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

/** Accounts made before email was set up haven't confirmed their address; they're asked to next time. */
function Unconfirmed({ count }: { count: number }) {
  return (
    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      {count === 1 ? '1 account hasn’t' : `${count} accounts haven’t`} confirmed an email address yet. They’ll be asked to the next time they open
      Kanbanto. If you know someone’s address can’t get email, confirm it for them in{' '}
      <a href={hrefFor({ page: 'admin', section: 'accounts' })} className="font-medium text-foreground underline">
        Accounts
      </a>
      .
    </p>
  )
}

function Usage({ info }: { info: PlatformEmail }) {
  const { usage, settings } = info
  const near = (used: number, limit: number | null) => limit !== null && used >= limit * 0.8
  const nearLimit = near(usage.month, settings.monthlyBudget) || near(usage.today, settings.dailyBudget)
  return (
    <div className="space-y-2 border-t pt-4">
      <Label>Sent by the site</Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Meter label="Today" used={usage.today} limit={settings.dailyBudget} />
        <Meter label="This month" used={usage.month} limit={settings.monthlyBudget} />
      </div>
      {nearLimit && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Getting close to the limit. Invites stop first (people get a link to share instead); sign-up and password emails keep working until the
          limit.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {info.ownKeys === 1 ? '1 person sends' : `${info.ownKeys} people send`} invites with their own Resend key; those don’t count here.
      </p>
    </div>
  )
}

/** A limit: empty means no limit. */
function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string
  label: string
  value: number | null
  onChange: (n: number | null) => void
  hint: string
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={0}
        value={value ?? ''}
        placeholder="No limit"
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="h-8"
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function Limits({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [v, setV] = useState({ dailyBudget: settings.dailyBudget, monthlyBudget: settings.monthlyBudget, userAllowance: settings.userAllowance })
  const changed = v.dailyBudget !== settings.dailyBudget || v.monthlyBudget !== settings.monthlyBudget || v.userAllowance !== settings.userAllowance
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api('PATCH', '/admin/email/settings', v)
          toast('Limits saved')
          onSaved()
        } catch (err) {
          toast.error(errorMessage(err))
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField id="daily" label="Per day" value={v.dailyBudget} onChange={(n) => setV({ ...v, dailyBudget: n })} hint="Emails the site sends" />
        <NumberField
          id="monthly"
          label="Per month"
          value={v.monthlyBudget}
          onChange={(n) => setV({ ...v, monthlyBudget: n })}
          hint="Emails the site sends"
        />
        <NumberField
          id="allowance"
          label="Invites per person"
          value={v.userAllowance}
          onChange={(n) => setV({ ...v, userAllowance: n })}
          hint="Each month, unless they use their own key"
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={!changed}>
        Save limits
      </Button>
    </form>
  )
}

function Branding({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [v, setV] = useState({ brandName: settings.brandName, brandColor: settings.brandColor, footer: settings.footer })
  const changed = v.brandName !== settings.brandName || v.brandColor !== settings.brandColor || v.footer !== settings.footer
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api('PATCH', '/admin/email/settings', v)
          toast('Branding saved')
          onSaved()
        } catch (err) {
          toast.error(errorMessage(err))
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="space-y-1">
          <Label htmlFor="brand-name" className="text-xs">
            Product name
          </Label>
          <Input id="brand-name" value={v.brandName} onChange={(e) => setV({ ...v, brandName: e.target.value })} className="h-8" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="brand-color" className="text-xs">
            Button colour
          </Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick a colour"
              value={v.brandColor}
              onChange={(e) => setV({ ...v, brandColor: e.target.value })}
              className="size-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
            />
            <Input
              id="brand-color"
              value={v.brandColor}
              onChange={(e) => setV({ ...v, brandColor: e.target.value })}
              className="h-8 font-mono text-xs"
            />
          </div>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="brand-footer" className="text-xs">
          Footer
        </Label>
        <Textarea
          id="brand-footer"
          rows={2}
          value={v.footer}
          onChange={(e) => setV({ ...v, footer: e.target.value })}
          placeholder={`Sent by ${v.brandName}. Your company’s postal address helps emails avoid spam folders.`}
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={!changed}>
        Save branding
      </Button>
    </form>
  )
}

/**
 * What each email looks like, with the saved branding, and sending one to yourself. The frame loads the
 * server's preview page directly (sandboxed: no scripts; the server also sends a strict CSP for it).
 */
function Previews({ canSend, version }: { canSend: boolean; version: string }) {
  const [kind, setKind] = useState<Kind>('invite')
  const [nonce, setNonce] = useState(0)
  const src = `/api/admin/email/preview/${kind}?v=${encodeURIComponent(version)}-${nonce}`

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto" />
        <div role="tablist" className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {(Object.keys(EMAIL_KIND_LABELS) as Kind[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={k === kind}
              onClick={() => setKind(k)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium text-muted-foreground',
                k === kind && 'bg-background text-foreground shadow-xs',
              )}
            >
              {EMAIL_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setNonce(nonce + 1)}>
          Refresh
        </Button>
        {canSend && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() =>
              api<{ sentTo: string }>('POST', `/admin/email/test/${kind}`).then(
                (r) => toast(`Sent to ${r.sentTo}`),
                (e) => toast.error(errorMessage(e)),
              )
            }
          >
            <PaperPlaneTilt /> Send it to me
          </Button>
        )}
      </div>
      <iframe title={`${EMAIL_KIND_LABELS[kind]} preview`} sandbox="" src={src} className="h-[26rem] w-full rounded-lg border bg-white" />
      <a href={src} target="_blank" rel="noreferrer" className="inline-block text-xs text-muted-foreground hover:text-foreground hover:underline">
        Open in a new tab
      </a>
    </div>
  )
}
