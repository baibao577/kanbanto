import { ArrowSquareOut, Copy } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { AdminGoogleCalendar, AdminSettings, OAuthMode, WebhookMode } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useLoaded } from '@/data/useLoaded'

const fetchSettings = () => api<AdminSettings>('GET', '/admin/settings')

const WEBHOOKS: { value: WebhookMode; title: string; hint: string }[] = [
  { value: 'off', title: 'Off', hint: 'Board owners can’t add webhooks.' },
  {
    value: 'public',
    title: 'To public addresses only',
    hint: 'https:// addresses on the internet (Zapier, Slack, your own server). The safe choice for a site anyone can sign up to.',
  },
  {
    value: 'any',
    title: 'To any address, including this server’s network',
    hint: 'Also http:// and private addresses, for tools inside your network (a self-hosted n8n). Only if you trust everyone who owns a board here: they could make this server send requests into your network.',
  },
]

const OAUTH: { value: OAuthMode; title: string; hint: string }[] = [
  { value: 'off', title: 'Off', hint: 'Apps can’t connect by signing in. People can still use API tokens, if those are on.' },
  {
    value: 'known',
    title: 'Known AI apps only',
    hint: 'Claude (on the web and in Claude Desktop), ChatGPT, and apps on the person’s own computer (Claude Code, Cursor). This site must be reachable from the internet over https.',
  },
  {
    value: 'any',
    title: 'Any app',
    hint: 'Any app that registers itself. People still approve each one, and see where it sends them back to, but an app could pretend to be one they know.',
  },
]

/**
 * Platform console → Integrations: whether people can make API tokens, where board owners may send webhooks, which
 * apps may connect to people's accounts by signing in (OAuth, for MCP), and people's calendars (links, Google Calendar).
 */
export function IntegrationsSection() {
  const [settings, load] = useLoaded(fetchSettings)
  /** Goes up when the Google app is saved or taken away, so what depends on it is read again. */
  const [googleApp, setGoogleApp] = useState(0)

  const save = async (fields: Partial<AdminSettings>, done: string) => {
    try {
      await api('PATCH', '/admin/settings', fields)
      toast(done)
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle
        title="Integrations"
        description={
          <>
            Let people connect their boards to other apps, scripts and AI assistants.{' '}
            <a href="/api/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              API reference <ArrowSquareOut className="size-3.5" />
            </a>
          </>
        }
      />
      {settings && (
        <>
          <SettingsCard
            title="People can make API tokens"
            description="Each person makes their own, in Account settings → API & apps. A token acts as its person, with their access, including for AI assistants (MCP). Turning this off stops every token at once."
            action={
              <Switch
                checked={settings.apiTokens}
                aria-label="People can make API tokens"
                onCheckedChange={(on) => void save({ apiTokens: on }, on ? 'API tokens turned on' : 'API tokens turned off')}
              />
            }
          >
            <p className="text-xs text-muted-foreground">
              Tokens can’t reach anyone’s account settings or this console, and read-only tokens can’t change anything.
            </p>
          </SettingsCard>

          <SettingsCard
            title="Apps that connect by signing in"
            description="Lets people connect AI apps to their boards without copying a token: they add Kanbanto in the app, sign in here, and approve it. The app gets the MCP tools only, with the person’s access. People see and disconnect their apps in Account settings → API & apps."
          >
            <RadioGroup value={settings.oauthApps} onValueChange={(v) => void save({ oauthApps: v as OAuthMode }, 'Saved')} className="gap-2">
              {OAUTH.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem value={o.value} className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{o.title}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{o.hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </SettingsCard>

          <SettingsCard
            title="Webhooks"
            description="Board owners can have each change on their board sent to another app or a chat channel, as it happens (Board settings → People & apps)."
          >
            <RadioGroup
              value={settings.webhooks}
              onValueChange={(v) => void save({ webhooks: v as WebhookMode }, 'Webhook setting saved')}
              className="gap-2"
            >
              {WEBHOOKS.map((w) => (
                <label
                  key={w.value}
                  className="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem value={w.value} className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{w.title}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{w.hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </SettingsCard>

          <SettingsCard
            title="People can make calendar links"
            description="Each person makes their own, in Account settings → Calendar: a private address that calendar apps (Apple Calendar, Outlook) subscribe to, showing the due dates and reminders of their cards. Turning this off stops every link at once."
            action={
              <Switch
                checked={settings.calendarLinks}
                aria-label="People can make calendar links"
                onCheckedChange={(on) => void save({ calendarLinks: on }, on ? 'Calendar links turned on' : 'Calendar links turned off')}
              />
            }
          >
            <p className="text-xs text-muted-foreground">
              A link works without signing in: anyone who has a person’s link can read the titles and dates of that person’s cards, and nothing else.
            </p>
          </SettingsCard>

          <GoogleCalendar
            onChange={() => {
              setGoogleApp((n) => n + 1)
              void load()
            }}
          />
          <GoogleSignIn
            key={googleApp}
            on={settings.googleSignIn}
            onChange={(on) => void save({ googleSignIn: on }, on ? 'Signing in with Google turned on' : 'Signing in with Google turned off')}
          />

          <SettingsCard
            title="Boards can have a Telegram bot"
            description="A board’s owner connects a bot of their own (made at @BotFather in Telegram) in Board settings → People & apps: one chat then gets the board’s news, and what is sent there can become cards. A bot someone connects to their own chat also tells them their reminders and mentions. Turning this off stops every bot at once."
            action={
              <Switch
                checked={settings.telegramBots}
                aria-label="Boards can have a Telegram bot"
                onCheckedChange={(on) => void save({ telegramBots: on }, on ? 'Telegram bots turned on' : 'Telegram bots turned off')}
              />
            }
          >
            <p className="text-xs text-muted-foreground">
              Each bot belongs to whoever made it: this site holds its token, encrypted. The server keeps one connection to Telegram open for each bot
              that takes cards. Everything said in those chats passes through Telegram.
            </p>
          </SettingsCard>
        </>
      )}
    </div>
  )
}

const fetchGoogle = () => api<AdminGoogleCalendar>('GET', '/admin/calendar/google')

/**
 * The site's Google app, which lets people connect their Google Calendar: its client ID and secret, made once in
 * Google Cloud. The secret is kept encrypted and never shown again.
 */
function GoogleCalendar({ onChange }: { onChange: () => void }) {
  const [loaded, load] = useLoaded(fetchGoogle)
  const [clientId, setClientId] = useState<string | null>(null)
  const [secret, setSecret] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  if (!loaded) return null
  const id = clientId ?? loaded.clientId ?? ''

  const save = async () => {
    try {
      await api('PUT', '/admin/calendar/google', { clientId: id, ...(secret.trim() && { clientSecret: secret }) })
      toast('Saved. People can connect Google Calendar in Account settings → Calendar.')
      setSecret('')
      setClientId(null)
      await load()
      onChange()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(loaded.redirectUri)
      toast('Address copied')
    } catch {
      toast.error('Couldn’t copy. Select it and copy it yourself.')
    }
  }

  return (
    <SettingsCard
      title="Google Calendar"
      description="Lets people connect their Google Calendar in Account settings → Calendar: Kanbanto keeps a calendar of its own in their Google account up to date with their cards. It needs a Google app, which you make once."
    >
      <ol className="list-decimal space-y-1 rounded-md bg-muted/50 py-2.5 pr-3 pl-7 text-xs leading-relaxed text-muted-foreground">
        <li>
          In{' '}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Google Cloud <ArrowSquareOut className="size-3" />
          </a>
          , make a project and turn on the Google Calendar API.
        </li>
        <li>Set up the consent screen for “External” users, and publish it: left in “Testing”, Google ends every connection after 7 days.</li>
        <li>Create an OAuth client ID of type “Web application”, with the address below as an authorized redirect URI.</li>
        <li>Paste its client ID and client secret here.</li>
      </ol>
      <div className="space-y-1.5">
        <Label htmlFor="google-redirect">Authorized redirect URI (give this to Google)</Label>
        <div className="flex items-center gap-2">
          <Input id="google-redirect" readOnly value={loaded.redirectUri} onFocus={(e) => e.target.select()} className="h-8 font-mono text-xs" />
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy()}>
            <Copy /> Copy
          </Button>
        </div>
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="google-client-id">Client ID</Label>
          <Input
            id="google-client-id"
            value={id}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234567890-abc123.apps.googleusercontent.com"
            autoComplete="off"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="google-client-secret">Client secret</Label>
          <Input
            id="google-client-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={loaded.configured ? 'Saved. Type a new one to replace it.' : 'GOCSPX-…'}
            autoComplete="off"
            required={!loaded.configured}
          />
          <p className="text-xs text-muted-foreground">It’s stored encrypted and never shown again.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!id.trim() || (!loaded.configured && !secret.trim())}>
            Save
          </Button>
          {loaded.configured && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setConfirm({
                  title: 'Stop using this Google app?',
                  description:
                    'Nobody can connect Google Calendar, and calendars already connected stop updating, until a Google app is saved again. Signing in with Google is turned off too.',
                  confirmLabel: 'Stop using it',
                  destructive: true,
                  onConfirm: () =>
                    api('DELETE', '/admin/calendar/google').then(
                      () => {
                        toast('Google Calendar turned off')
                        setClientId(null)
                        void load()
                        onChange()
                      },
                      (e) => toast.error(errorMessage(e)),
                    ),
                })
              }
            >
              Stop using it
            </Button>
          )}
          {loaded.configured && (
            <span className="text-xs text-muted-foreground">
              {loaded.connections === 1 ? '1 person has' : `${loaded.connections} people have`} connected Google Calendar.
            </span>
          )}
        </div>
      </form>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </SettingsCard>
  )
}

/**
 * "Continue with Google" on the sign-in and sign-up pages, through the same Google app: a switch, and the second
 * address that app has to allow.
 */
function GoogleSignIn({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [loaded] = useLoaded(fetchGoogle)
  if (!loaded) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(loaded.signInRedirectUri)
      toast('Address copied')
    } catch {
      toast.error('Couldn’t copy. Select it and copy it yourself.')
    }
  }
  return (
    <SettingsCard
      title="People can sign in with Google"
      description="Adds “Continue with Google” to the sign-in and sign-up pages, through the Google app above. Google has already checked the address, so an account made this way needs no confirmation email, and someone whose address already has an account here gets that account."
      action={<Switch checked={on} disabled={!loaded.configured && !on} aria-label="People can sign in with Google" onCheckedChange={onChange} />}
    >
      <div className="space-y-1.5">
        <Label htmlFor="google-signin-redirect">A second authorized redirect URI (add it to the same client at Google first)</Label>
        <div className="flex items-center gap-2">
          <Input
            id="google-signin-redirect"
            readOnly
            value={loaded.signInRedirectUri}
            onFocus={(e) => e.target.select()}
            className="h-8 font-mono text-xs"
          />
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy()}>
            <Copy /> Copy
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {loaded.configured
          ? 'While sign-up is closed, Google only lets in people who have an account or an invite. Turned off later, people who signed up with Google get back in with “Forgot password”, or a reset link from you.'
          : 'Save the Google app above first.'}
      </p>
    </SettingsCard>
  )
}
