import {
  ArrowClockwise,
  ArrowLeft,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  Key,
  PaperPlaneTilt,
  PlugsConnected,
  Trash,
} from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { WEBHOOK_EVENTS, type WebhookDeliveryDetail, type WebhookEventName, type WebhookMode, type WebhookView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
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

/** The events, in words. */
const EVENT_LABEL: Record<WebhookEventName, string> = {
  'board.changed': 'Card changes',
  'comment.added': 'Comments',
  'reminder.due': 'Reminders',
}

/** A green, red or grey dot: working, failing, paused. */
function StatusDot({ h }: { h: WebhookView }) {
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', !h.active ? 'bg-muted-foreground/40' : h.lastError ? 'bg-destructive' : 'bg-status-done')}
      aria-label={!h.active ? 'Paused' : h.lastError ? 'Failing' : 'Working'}
    />
  )
}

function useWebhooks() {
  const { data } = useBoard()
  const base = `/boards/${data.board.id}/webhooks`
  const [loaded, load] = useLoaded(useCallback(() => api<{ mode: WebhookMode; webhooks: WebhookView[] }>('GET', base), [base]))
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
  return { base, loaded, load, act }
}

/**
 * A board's webhooks, inside Board settings (owners): addresses that get the board's changes, comments and reminders as
 * they happen, signed with a secret. Where they may point is up to the platform admins (off, public only, anywhere).
 */
export function WebhookList({ onOpen }: { onOpen: (id: string) => void }) {
  const { loaded, act } = useWebhooks()
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState<string | null>(null)

  if (!loaded) return <div className="h-16" />
  if (loaded.mode === 'off')
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Webhooks are turned off on this site. A platform admin can turn them on (Platform console → Integrations).
      </p>
    )

  const add = async () => {
    const r = await act<{ id: string; secret: string }>('POST', '', { url: url.trim() })
    if (r) {
      setSecret(r.secret)
      setUrl('')
    }
  }

  return (
    <div className="divide-y">
      {loaded.webhooks.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => onOpen(h.id)}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50"
        >
          <StatusDot h={h} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{h.url}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {!h.active ? 'Paused' : h.events.map((e) => EVENT_LABEL[e]).join(' · ')}
              {h.active && h.lastDeliveryAt && ` · last ${ago(h.lastDeliveryAt)}`}
            </span>
          </span>
          <CaretRight className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
      <form
        className="space-y-1.5 p-4"
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
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={!url.trim()}>
            Add
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {loaded.mode === 'public' ? 'An https:// address on the internet.' : 'An http:// or https:// address, on the internet or your network.'}{' '}
          <a href="/api/docs#webhooks" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            What’s sent <ArrowSquareOut className="size-3" />
          </a>
        </p>
        {secret && <SecretBox secret={secret} note="Added. Deliveries are signed with this secret, so the receiver can check they came from here." />}
      </form>
    </div>
  )
}

function SecretBox({ secret, note }: { secret: string; note: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-status-done/40 bg-status-done/8 p-3 text-xs">
      <p>{note}</p>
      <div className="flex items-center gap-2">
        <Input readOnly value={secret} onFocus={(e) => e.target.select()} className="h-8 font-mono text-xs" aria-label="Signing secret" />
        <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy(secret, 'Secret')}>
          <Copy /> Copy
        </Button>
      </div>
    </div>
  )
}

/**
 * One webhook: what it sends, its secret, a test, and its delivery log (the last 50, or only the ones that failed),
 * where each delivery shows what was sent and what came back, and can be sent again.
 */
export function WebhookDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { base, loaded, act } = useWebhooks()
  const [secret, setSecret] = useState<string | null>(null)
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [log, reloadLog] = useLoaded(
    useCallback(
      () => api<{ deliveries: WebhookDeliveryDetail[] }>('GET', `${base}/${id}/deliveries${onlyFailed ? '?failed=1' : ''}`),
      [base, id, onlyFailed],
    ),
  )
  const h = loaded?.webhooks.find((x) => x.id === id)

  const header = (
    <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-3.5" /> Webhooks
    </button>
  )
  if (!loaded) return header
  if (!h)
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-muted-foreground">This webhook was deleted.</p>
      </div>
    )

  const test = async () => {
    const r = await act<{ ok: boolean; status: number | null; error: string | null }>('POST', `/${h.id}/test`)
    if (r?.ok) toast('Test delivered', { description: `The address answered ${r.status}.` })
    else if (r) toast.error('The test didn’t go through', { description: r.error ?? undefined })
    await reloadLog()
  }
  const resend = async (d: WebhookDeliveryDetail) => {
    const r = await act<{ ok: boolean; status: number | null; error: string | null }>('POST', `/${h.id}/deliveries/${d.id}/resend`)
    if (r?.ok) toast('Sent again', { description: `The address answered ${r.status}.` })
    else if (r) toast.error('It didn’t go through', { description: r.error ?? undefined })
    await reloadLog()
  }

  return (
    <div className="space-y-5">
      {header}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <StatusDot h={h} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.url}</span>
          <Switch
            checked={h.active}
            aria-label={h.active ? 'Pause' : 'Resume'}
            onCheckedChange={(on) => void act('PATCH', `/${h.id}`, { active: on })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-3 text-xs">
          <span className="mr-1 text-muted-foreground">Sends</span>
          {WEBHOOK_EVENTS.map((e) => {
            const on = h.events.includes(e)
            return (
              <button
                key={e}
                type="button"
                aria-pressed={on}
                disabled={on && h.events.length === 1}
                title={on && h.events.length === 1 ? 'A webhook sends at least one kind of event' : undefined}
                onClick={() => void act('PATCH', `/${h.id}`, { events: on ? h.events.filter((x) => x !== e) : [...h.events, e] })}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-full border px-2 transition-colors disabled:cursor-not-allowed',
                  on ? 'border-primary/40 bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {on && <Check weight="bold" className="size-3" />}
                {EVENT_LABEL[e]}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void test()}>
            <PaperPlaneTilt /> Send a test
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={async () => {
              const r = await act<{ secret: string }>('GET', `/${h.id}/secret`)
              if (r) setSecret(r.secret)
            }}
          >
            <Key /> Show the secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={async () => {
              if (!confirm('Make a new secret? The old one stops working at once.')) return
              const r = await act<{ secret: string }>('POST', `/${h.id}/secret`)
              if (r) setSecret(r.secret)
            }}
          >
            <ArrowClockwise /> New secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-destructive hover:text-destructive"
            onClick={async () => {
              if (!confirm('Delete this webhook? Nothing more is sent to it.')) return
              if (await act('DELETE', `/${h.id}`)) {
                toast('Webhook deleted')
                onBack()
              }
            }}
          >
            <Trash /> Delete
          </Button>
        </div>
        {secret && (
          <div className="px-4 pb-4">
            <SecretBox secret={secret} note="The signing secret: the receiver uses it to check deliveries came from here." />
          </div>
        )}
      </div>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Deliveries</h3>
          <span className="text-xs text-muted-foreground">kept for a week</span>
          <div className="ml-auto flex rounded-md border p-0.5 text-xs">
            {[false, true].map((f) => (
              <button
                key={String(f)}
                type="button"
                aria-pressed={onlyFailed === f}
                onClick={() => setOnlyFailed(f)}
                className={cn('rounded px-2 py-0.5', onlyFailed === f ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground')}
              >
                {f ? 'Failed' : 'All'}
              </button>
            ))}
          </div>
        </div>
        {!log ? (
          <div className="h-16" />
        ) : !log.deliveries.length ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            {onlyFailed ? 'Nothing failed. 🎉' : 'Nothing sent yet. Try “Send a test”.'}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card text-xs">
            {log.deliveries.map((d) => {
              const expanded = open === d.id
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : d.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
                  >
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        d.status === 'sent' ? 'bg-status-done' : d.status === 'failed' ? 'bg-destructive' : 'bg-warning',
                      )}
                    />
                    <span className="w-28 shrink-0 font-mono">{d.event}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {d.status === 'sent'
                        ? `Delivered (${d.responseStatus})`
                        : d.status === 'failed'
                          ? `Gave up after ${d.attempts} tries: ${d.error}`
                          : `Retrying (${d.attempts} ${d.attempts === 1 ? 'try' : 'tries'} so far): ${d.error ?? 'waiting'}`}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{ago(d.createdAt)}</span>
                    {expanded ? <CaretDown className="size-3.5 shrink-0" /> : <CaretRight className="size-3.5 shrink-0" />}
                  </button>
                  {expanded && (
                    <div className="space-y-2 border-t bg-muted/30 px-3 py-3">
                      <p className="font-medium">Sent</p>
                      <pre className="max-h-56 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-snug">
                        {JSON.stringify(d.payload, null, 2)}
                      </pre>
                      <p className="font-medium">
                        Answer {d.responseStatus !== null && <span className="font-normal text-muted-foreground">· {d.responseStatus}</span>}
                      </p>
                      <pre className="max-h-40 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
                        {d.response ?? (d.error ? d.error : '(empty)')}
                      </pre>
                      <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => void resend(d)}>
                        <PlugsConnected /> Send again
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
