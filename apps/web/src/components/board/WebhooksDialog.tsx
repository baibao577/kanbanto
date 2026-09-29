import { ArrowSquareOut, CheckCircle, Copy, DotsThree, Key, PaperPlaneTilt, Trash, WarningCircle } from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { WebhookMode, WebhookView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useLoaded } from '@/data/useLoaded'
import { cn } from '@/lib/utils'

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast.error('Couldn’t copy. Select it and copy it yourself.')
  }
}

const ago = (iso: string) => formatDistanceToNow(parseISO(iso), { addSuffix: true })

/**
 * A board's webhooks (its owners): addresses that get each change on the board as it happens, signed with a secret.
 * Where they may point is up to the platform admins (off, public addresses only, or anywhere).
 */
export function WebhooksDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useBoard()
  const base = `/boards/${data.board.id}/webhooks`
  const [loaded, load] = useLoaded(useCallback(() => api<{ mode: WebhookMode; webhooks: WebhookView[] }>('GET', base), [base]))
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null)

  const act = async <T,>(method: 'POST' | 'PATCH' | 'DELETE' | 'GET', path: string, body?: unknown) => {
    try {
      const r = await api<T>(method, `${base}${path}`, body)
      await load()
      return r
    } catch (e) {
      toast.error(errorMessage(e))
      return null
    }
  }

  const add = async () => {
    const r = await act<{ id: string; secret: string }>('POST', '', { url: url.trim() })
    if (r) {
      setSecret({ url: url.trim(), secret: r.secret })
      setUrl('')
    }
  }

  const test = async (h: WebhookView) => {
    const r = await act<{ ok: boolean; status: number | null; error: string | null }>('POST', `/${h.id}/test`)
    if (r?.ok) toast('Test delivered', { description: `The address answered ${r.status}.` })
    else if (r) toast.error('The test didn’t go through', { description: r.error ?? undefined })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Webhooks</DialogTitle>
          <DialogDescription>
            Each change on “{data.board.name}”, and each new comment, is sent to these addresses as it happens: for Slack, n8n, Zapier or your own
            server.{' '}
            <a
              href="/api/docs#webhooks"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              What’s sent <ArrowSquareOut className="size-3.5" />
            </a>
          </DialogDescription>
        </DialogHeader>

        {!loaded ? (
          <div className="h-32" />
        ) : loaded.mode === 'off' ? (
          <p className="rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            Webhooks are turned off on this site. A platform admin can turn them on (Platform console → Integrations).
          </p>
        ) : (
          <div className="space-y-5">
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                void add()
              }}
            >
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/kanbanto-hook"
                  aria-label="Webhook address"
                  className="h-9"
                  required
                />
                <Button type="submit" disabled={!url.trim()}>
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {loaded.mode === 'public'
                  ? 'An https:// address on the internet.'
                  : 'An http:// or https:// address, on the internet or your network.'}
              </p>
            </form>

            {secret && (
              <div className="space-y-2 rounded-lg border border-status-done/40 bg-status-done/8 p-3 text-sm">
                <p>
                  <span className="font-medium">Added.</span> Deliveries are signed with this secret, so the receiver can check they came from here
                  (you can show it again later).
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={secret.secret}
                    onFocus={(e) => e.target.select()}
                    className="h-8 font-mono text-xs"
                    aria-label="Signing secret"
                  />
                  <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy(secret.secret, 'Secret')}>
                    <Copy /> Copy
                  </Button>
                </div>
              </div>
            )}

            {loaded.webhooks.length > 0 && (
              <ul className="space-y-3">
                {loaded.webhooks.map((h) => {
                  const failing = !!h.lastError
                  return (
                    <li key={h.id} className="rounded-lg border">
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <span className={cn('shrink-0', !h.active ? 'text-muted-foreground' : failing ? 'text-destructive' : 'text-status-done')}>
                          {failing ? <WarningCircle weight="fill" className="size-4" /> : <CheckCircle weight="fill" className="size-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-xs">{h.url}</span>
                          <span className={cn('block truncate text-xs', failing ? 'text-destructive' : 'text-muted-foreground')}>
                            {!h.active
                              ? 'Paused'
                              : h.lastDeliveryAt
                                ? `${failing ? h.lastError : `Delivered (${h.lastStatus})`} · ${ago(h.lastDeliveryAt)}`
                                : 'Nothing sent yet'}
                          </span>
                        </span>
                        <Switch
                          checked={h.active}
                          aria-label={h.active ? 'Pause' : 'Resume'}
                          onCheckedChange={(on) => void act('PATCH', `/${h.id}`, { active: on })}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8" aria-label={`${h.url} options`}>
                              <DotsThree weight="bold" className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem onSelect={() => void test(h)}>
                              <PaperPlaneTilt /> Send a test
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={async () => {
                                const r = await act<{ secret: string }>('GET', `/${h.id}/secret`)
                                if (r) setSecret({ url: h.url, secret: r.secret })
                              }}
                            >
                              <Key /> Show the secret
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={async () => {
                                const r = await act<{ secret: string }>('POST', `/${h.id}/secret`)
                                if (r) {
                                  setSecret({ url: h.url, secret: r.secret })
                                  toast('New secret made. The old one no longer works.')
                                }
                              }}
                            >
                              <Key /> Make a new secret
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => void act('DELETE', `/${h.id}`).then((r) => r && toast('Webhook deleted'))}
                            >
                              <Trash /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {h.recent.length > 0 && (
                        <ul className="space-y-1 border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                          {h.recent.map((d) => (
                            <li key={d.id} className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  d.status === 'sent' ? 'bg-status-done' : d.status === 'failed' ? 'bg-destructive' : 'bg-warning',
                                )}
                              />
                              <span className="w-28 shrink-0 font-mono">{d.event}</span>
                              <span className="min-w-0 flex-1 truncate">
                                {d.status === 'sent'
                                  ? `Delivered (${d.responseStatus})`
                                  : d.status === 'failed'
                                    ? `Gave up after ${d.attempts} tries: ${d.error}`
                                    : `Retrying (${d.attempts} ${d.attempts === 1 ? 'try' : 'tries'} so far): ${d.error}`}
                              </span>
                              <span className="shrink-0">{ago(d.createdAt)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
