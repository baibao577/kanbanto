import { CheckCircle, Key, Warning } from '@phosphor-icons/react'
import { useState, type ReactNode } from 'react'
import type { EmailSender, SaveEmailSender, SmtpSecurity } from '@kanbanto/model/api'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

type Provider = EmailSender['provider']

const SECURITY: { value: SmtpSecurity; label: string; port: number }[] = [
  { value: 'starttls', label: 'STARTTLS', port: 587 },
  { value: 'tls', label: 'TLS', port: 465 },
  { value: 'none', label: 'None', port: 25 },
]
const securityLabel = (s: SmtpSecurity) => SECURITY.find((x) => x.value === s)!.label

/**
 * How email is sent: a Resend key, or (for the site, when `providers` includes it) an SMTP server. Secrets are
 * write-only: once saved, a key shows only as a hint (re_…a1b2) and a password not at all. Saving sends a test email
 * first; if it's refused, nothing is saved and the reason is shown.
 */
export function EmailKeyForm({
  sender,
  encryptionReady,
  testRecipient,
  fromPlaceholder,
  providers = ['resend'],
  onSave,
  onRemove,
}: {
  sender: EmailSender | null
  encryptionReady: boolean
  /** Where the test email goes (the person saving). */
  testRecipient: string
  fromPlaceholder: string
  providers?: Provider[]
  onSave: (fields: SaveEmailSender) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const [editing, setEditing] = useState(!sender)
  const [provider, setProvider] = useState<Provider>(sender?.provider ?? providers[0])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (sender?.fromServer) return <ServerSender sender={sender} />

  if (!encryptionReady)
    return (
      <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        The server has no encryption key yet, so email settings can’t be saved. Restart Kanbanto: it makes one when it starts.
      </p>
    )

  if (sender && !editing)
    return (
      <div className="space-y-3">
        <SenderStatus sender={sender} />
        {sender.testingOnly && <TestingOnlyNote />}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setProvider(sender.provider)
              setEditing(true)
            }}
          >
            Change
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={async () => {
              setBusy(true)
              await onRemove().catch((e) => setError(errorMessage(e)))
              setBusy(false)
            }}
            disabled={busy}
          >
            {sender.provider === 'resend' ? 'Remove key' : 'Stop sending email'}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    )

  const save = async (fields: SaveEmailSender) => {
    setBusy(true)
    setError(null)
    try {
      await onSave(fields)
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const saved = sender?.provider === provider ? sender : null
  const footer = (
    <>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="gap-1.5" disabled={busy}>
          <Key /> {busy ? 'Sending a test…' : 'Save and send a test'}
        </Button>
        {sender && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
        <span className="text-xs text-muted-foreground">The test goes to {testRecipient}.</span>
      </div>
    </>
  )

  return (
    <div className="space-y-4">
      {providers.length > 1 && (
        <div role="tablist" aria-label="Send with" className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
          {providers.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={p === provider}
              onClick={() => {
                setProvider(p)
                setError(null)
              }}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium text-muted-foreground',
                p === provider && 'bg-background text-foreground shadow-xs',
              )}
            >
              {p === 'resend' ? 'Resend' : 'SMTP server'}
            </button>
          ))}
        </div>
      )}
      {provider === 'resend' ? (
        <ResendFields key="resend" saved={saved} fromPlaceholder={fromPlaceholder} onSubmit={save} footer={footer} />
      ) : (
        <SmtpFields key="smtp" saved={saved} fromPlaceholder={fromPlaceholder} onSubmit={save} footer={footer} />
      )}
    </div>
  )
}

type FieldsProps = { saved: EmailSender | null; fromPlaceholder: string; onSubmit: (f: SaveEmailSender) => Promise<void>; footer: ReactNode }

function ResendFields({ saved, fromPlaceholder, onSubmit, footer }: FieldsProps) {
  const [apiKey, setApiKey] = useState('')
  const [from, setFrom] = useState(saved?.from ?? '')
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit({ provider: 'resend', apiKey: apiKey.trim() || undefined, from: from.trim() })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="email-key">Resend API key</Label>
        <Input
          id="email-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={saved ? `Leave empty to keep ${saved.keyHint}` : 're_…'}
          required={!saved}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          In Resend → API Keys, create a key with <b>Sending access</b>, limited to your domain. It’s stored encrypted and never shown again.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email-from">Send from</Label>
        <Input id="email-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={fromPlaceholder} required />
        <p className="text-xs text-muted-foreground">The address must be on a domain you’ve verified in Resend.</p>
      </div>
      {/@resend\.dev>?\s*$/i.test(from) && <TestingOnlyNote />}
      {footer}
    </form>
  )
}

function SmtpFields({ saved, fromPlaceholder, onSubmit, footer }: FieldsProps) {
  const s = saved?.smtp
  const [host, setHost] = useState(s?.host ?? '')
  const [port, setPort] = useState(String(s?.port ?? 587))
  const [security, setSecurity] = useState<SmtpSecurity>(s?.security ?? 'starttls')
  const [username, setUsername] = useState(s?.username ?? '')
  const [password, setPassword] = useState('')
  const [allowSelfSigned, setAllowSelfSigned] = useState(s?.allowSelfSigned ?? false)
  const [from, setFrom] = useState(saved?.from ?? '')
  const hasSavedPassword = !!s?.username
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit({
          provider: 'smtp',
          host: host.trim(),
          port: Number(port),
          security,
          username: username.trim(),
          password: password || (hasSavedPassword ? undefined : ''),
          allowSelfSigned,
          from: from.trim(),
        })
      }}
    >
      <p className="text-xs text-muted-foreground">
        Your company’s mail server, Microsoft 365, Google Workspace, or any email service that offers SMTP (Amazon SES, Postmark, Mailgun, Brevo…).
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
        <div className="space-y-1.5">
          <Label htmlFor="smtp-host">Server</Label>
          <Input
            id="smtp-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="smtp-port">Port</Label>
          <Input id="smtp-port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Encryption</Label>
        <div role="radiogroup" aria-label="Encryption" className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
          {SECURITY.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === security}
              onClick={() => {
                // Follow the usual port, unless someone typed their own.
                if (SECURITY.some((x) => String(x.port) === port)) setPort(String(o.port))
                setSecurity(o.value)
              }}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium text-muted-foreground',
                o.value === security && 'bg-background text-foreground shadow-xs',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {security === 'starttls'
            ? 'Most servers, usually on port 587.'
            : security === 'tls'
              ? 'Encrypted from the start, usually on port 465.'
              : 'No encryption: only for a mail server inside your own network, usually on port 25.'}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="smtp-user">Username</Label>
          <Input id="smtp-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
          <p className="text-xs text-muted-foreground">Leave empty if the server doesn’t ask you to sign in.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="smtp-password">Password</Label>
          <Input
            id="smtp-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!username.trim()}
            placeholder={hasSavedPassword ? 'Leave empty to keep the saved one' : ''}
          />
          <p className="text-xs text-muted-foreground">Stored encrypted and never shown again. Some services call it an app password.</p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="smtp-from">Send from</Label>
        <Input id="smtp-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={fromPlaceholder} required />
        <p className="text-xs text-muted-foreground">An address this server is allowed to send from.</p>
      </div>
      <Label className="flex items-start gap-2 font-normal">
        <Checkbox checked={allowSelfSigned} onCheckedChange={(v) => setAllowSelfSigned(v === true)} className="mt-0.5" />
        <span className="space-y-0.5">
          <span className="block text-sm">Allow a self-signed certificate</span>
          <span className="block text-xs text-muted-foreground">
            Only for your company’s own mail server, if its certificate isn’t from a public authority.
          </span>
        </span>
      </Label>
      {footer}
    </form>
  )
}

function SenderStatus({ sender }: { sender: EmailSender }) {
  const smtp = sender.smtp
  const title = !sender.working ? 'Emails aren’t going out' : sender.provider === 'resend' ? 'Sending with Resend' : `Sending through ${smtp?.host}`
  const detail =
    sender.provider === 'resend' || !smtp
      ? `From ${sender.from} · key ${sender.keyHint}`
      : `From ${sender.from} · ${sender.keyHint} · ${securityLabel(smtp.security)} · ${smtp.username ? `signs in as ${smtp.username}` : 'no sign-in'}`
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      {sender.working ? (
        <CheckCircle weight="fill" className="mt-0.5 size-5 shrink-0 text-status-done" />
      ) : (
        <Warning weight="fill" className="mt-0.5 size-5 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs break-words text-muted-foreground">{detail}</p>
        {!sender.working && sender.lastError && (
          <p className="text-xs text-destructive">
            {sender.provider === 'resend' ? 'Resend said: ' : ''}
            {sender.lastError}
          </p>
        )}
      </div>
    </div>
  )
}

/** Set with SMTP_URL on the server: shown, not editable here. */
function ServerSender({ sender }: { sender: EmailSender }) {
  return (
    <div className="space-y-3">
      <SenderStatus sender={sender} />
      <p className="text-xs text-muted-foreground">
        Set on the server with <code className="rounded bg-muted px-1">SMTP_URL</code> and <code className="rounded bg-muted px-1">SMTP_FROM</code>.
        To change it, edit the server’s settings and restart Kanbanto. Use <b>Send it to me</b> below to check it works.
      </p>
    </div>
  )
}

function TestingOnlyNote() {
  return (
    <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <b>Testing only.</b> Resend’s resend.dev address can only send to your own Resend account’s email. To email other people, verify a domain you
      own in Resend and send from it.
    </p>
  )
}
