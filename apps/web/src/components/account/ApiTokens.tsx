import { ArrowSquareOut, Copy, Key, Trash } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useState } from 'react'
import { toast } from 'sonner'
import type { ApiTokenView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { hrefFor } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLoaded } from '@/data/useLoaded'

const fetchTokens = () => api<{ enabled: boolean; tokens: ApiTokenView[] }>('GET', '/account/tokens')
const EXPIRY = { '30': '30 days', '90': '90 days', '365': '1 year', never: 'Never' } as const
const site = () => `${location.origin}${location.pathname.replace(/\/$/, '')}`

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast.error('Couldn’t copy. Select it and copy it yourself.')
  }
}

/** A command or snippet to copy. */
function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">
          {text}
        </pre>
        <Button variant="outline" size="icon" className="size-8 shrink-0" aria-label={`Copy: ${label}`} onClick={() => void copy(text, label)}>
          <Copy />
        </Button>
      </div>
    </div>
  )
}

/**
 * Account settings → API tokens: for scripts, integrations (n8n, Zapier) and AI assistants (MCP). A token acts as you;
 * it's shown once, when it's made. A platform admin has to turn tokens on first.
 */
export function ApiTokensSection() {
  const { user } = useAuth()
  const [loaded, load] = useLoaded(fetchTokens)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('write')
  const [expiry, setExpiry] = useState<keyof typeof EXPIRY>('90')
  const [made, setMade] = useState<{ token: string; name: string } | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)

  const create = async () => {
    try {
      const r = await api<ApiTokenView & { token: string }>('POST', '/account/tokens', {
        name: name.trim(),
        scope,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      })
      setMade({ token: r.token, name: r.name })
      setName('')
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const askDelete = (t: ApiTokenView) =>
    setConfirm({
      title: `Delete “${t.name}”?`,
      description: 'Anything using it stops working at once. This can’t be undone.',
      confirmLabel: 'Delete token',
      destructive: true,
      onConfirm: () =>
        api('DELETE', `/account/tokens/${t.id}`).then(
          () => {
            toast(`Deleted “${t.name}”`)
            void load()
          },
          (e) => toast.error(errorMessage(e)),
        ),
    })

  const token = made?.token ?? 'kbt_…'
  return (
    <div className="space-y-6">
      <PageTitle
        title="API tokens"
        description={
          <>
            Let scripts, other apps and AI assistants work with your boards. A token acts as you, with your access.{' '}
            <a href="/api/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              API reference <ArrowSquareOut className="size-3.5" />
            </a>
          </>
        }
      />
      {loaded && !loaded.enabled ? (
        <SettingsCard title="Turned off on this site">
          <p className="text-sm text-muted-foreground">
            API tokens need a platform admin to turn them on
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
        </SettingsCard>
      ) : (
        loaded && (
          <>
            <SettingsCard title="Make a token">
              <form
                className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="token-name">Name</Label>
                  <Input id="token-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code, n8n" required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="token-scope">Can</Label>
                  <Select value={scope} onValueChange={(v) => setScope(v as 'read' | 'write')}>
                    <SelectTrigger id="token-scope" className="w-full sm:w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="write">Read and make changes</SelectItem>
                      <SelectItem value="read">Only read</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="token-expiry">Expires</Label>
                  <Select value={expiry} onValueChange={(v) => setExpiry(v as keyof typeof EXPIRY)}>
                    <SelectTrigger id="token-expiry" className="w-full sm:w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(EXPIRY).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={!name.trim()}>
                  <Key /> Make token
                </Button>
              </form>

              {made && (
                <div className="space-y-2 rounded-lg border border-status-done/40 bg-status-done/8 p-3">
                  <p className="text-sm font-medium">Copy “{made.name}” now: it won’t be shown again.</p>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={made.token} onFocus={(e) => e.target.select()} className="h-8 font-mono text-xs" aria-label="New token" />
                    <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy(made.token, 'Token')}>
                      <Copy /> Copy
                    </Button>
                  </div>
                </div>
              )}
            </SettingsCard>

            <SettingsCard title={`Your tokens (${loaded.tokens.length})`}>
              {loaded.tokens.length ? (
                <ul className="divide-y">
                  {loaded.tokens.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{t.name}</span>
                          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t.scope === 'write' ? 'Read and change' : 'Read only'}
                          </span>
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          <span className="font-mono">{t.hint}</span> · made {formatDistanceToNow(parseISO(t.createdAt), { addSuffix: true })} ·{' '}
                          {t.lastUsedAt ? `used ${formatDistanceToNow(parseISO(t.lastUsedAt), { addSuffix: true })}` : 'never used'}
                          {t.expiresAt && ` · expires ${formatDistanceToNow(parseISO(t.expiresAt), { addSuffix: true })}`}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        aria-label={`Delete ${t.name}`}
                        onClick={() => askDelete(t)}
                      >
                        <Trash />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No tokens yet.</p>
              )}
            </SettingsCard>

            <SettingsCard
              title="Connect an AI assistant"
              description="Kanbanto speaks MCP, so assistants like Claude can find, add and update tasks for you. Use a token with only the access you want them to have."
            >
              <Snippet
                label="Claude Code"
                text={`claude mcp add --transport http kanbanto ${site()}/api/mcp \\\n  --header "Authorization: Bearer ${token}"`}
              />
              <Snippet
                label="Other MCP apps (Cursor, VS Code…)"
                text={JSON.stringify(
                  { mcpServers: { kanbanto: { url: `${site()}/api/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
                  null,
                  2,
                )}
              />
              <Snippet label="Scripts (curl)" text={`curl ${site()}/api/boards \\\n  -H "Authorization: Bearer ${token}"`} />
            </SettingsCard>
          </>
        )
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
