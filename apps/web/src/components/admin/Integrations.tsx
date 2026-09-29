import { ArrowSquareOut } from '@phosphor-icons/react'
import { toast } from 'sonner'
import type { AdminSettings, WebhookMode } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
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

/** Platform console → Integrations: whether people can make API tokens, and where board owners may send webhooks. */
export function IntegrationsSection() {
  const [settings, load] = useLoaded(fetchSettings)

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
            description="Each person makes their own, in Account settings → API tokens. A token acts as its person, with their access, including for AI assistants (MCP). Turning this off stops every token at once."
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
            title="Webhooks"
            description="Board owners can have each change on their board sent to another app, as it happens (Board settings → Webhooks)."
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
        </>
      )}
    </div>
  )
}
