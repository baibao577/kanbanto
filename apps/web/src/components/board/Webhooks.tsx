import {
  ArrowClockwise,
  ArrowLeft,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  DiscordLogo,
  GoogleLogo,
  Key,
  MicrosoftTeamsLogo,
  PaperPlaneTilt,
  PlugsConnected,
  SlackLogo,
  TelegramLogo,
  Trash,
  WebhooksLogo,
  type Icon,
} from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  WEBHOOK_EVENTS,
  WEBHOOK_FORMAT_NAMES,
  WEBHOOK_FORMATS,
  type TelegramConnect,
  type WebhookDeliveryDetail,
  type WebhookEventName,
  type WebhookFormat,
  type WebhookMode,
  type WebhookView,
} from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

/**
 * Each format: its icon, what its addresses look like, and where the chat app gives one out. (Kanbanto's own data
 * goes to any address; the hint for that depends on the site, see below.)
 */
const FORMAT: Record<WebhookFormat, { icon: Icon; placeholder: string; where?: string }> = {
  json: { icon: WebhooksLogo, placeholder: 'https://example.com/kanbanto-hook' },
  slack: {
    icon: SlackLogo,
    placeholder: 'https://hooks.slack.com/services/…',
    where: 'Slack gives a channel an address from an app of your own: api.slack.com/apps → Create New App → Incoming Webhooks.',
  },
  'google-chat': {
    icon: GoogleLogo,
    placeholder: 'https://chat.googleapis.com/v1/spaces/…',
    where: 'In the space, click its name → Apps & integrations → Webhooks, and copy the address it makes.',
  },
  teams: {
    icon: MicrosoftTeamsLogo,
    placeholder: 'https://….api.powerplatform.com/…',
    where: 'On the channel, click ⋯ → Workflows, pick the one that posts when a webhook request is received, and copy its address.',
  },
  discord: {
    icon: DiscordLogo,
    placeholder: 'https://discord.com/api/webhooks/…',
    where: 'In the channel’s settings: Integrations → Webhooks → New Webhook → Copy Webhook URL.',
  },
  // (A bot of the board's own, not an address: what's pasted is the bot's token.)
  telegram: { icon: TelegramLogo, placeholder: '123456789:AAH…' },
}
const isChat = (format: WebhookFormat) => format !== 'json'

/** The code that connects a chat to a bot just added (or asked for again), until the chat is connected: by webhook. */
const connecting = new Map<string, TelegramConnect>()

/** The words of a message that went to a chat app, out of the body that app was sent (null: show the body itself). */
function chatWords(payload: unknown): string | null {
  const p = payload as { text?: unknown; content?: unknown; attachments?: { content?: { body?: { text?: unknown }[] } }[] } | null
  if (typeof p?.text === 'string') return p.text
  if (typeof p?.content === 'string') return p.content
  const blocks = p?.attachments?.[0]?.content?.body
  return Array.isArray(blocks) ? blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : null
}

const notTelegram = (h: WebhookView) => !h.telegram

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
  const [loaded, load] = useLoaded(useCallback(() => api<{ mode: WebhookMode; telegramBots: boolean; webhooks: WebhookView[] }>('GET', base), [base]))
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
  const [format, setFormat] = useState<WebhookFormat>('json')
  // What was just added: a signing secret to copy, or (for a chat) the app the first message went to.
  const [added, setAdded] = useState<{ secret: string } | { chat: WebhookFormat } | null>(null)

  if (!loaded) return <div className="h-16" />
  if (loaded.mode === 'off')
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Webhooks are turned off on this site. A platform admin can turn them on (Platform console → Integrations).
      </p>
    )

  const add = async () => {
    const r = await act<{ id: string; secret?: string }>('POST', '', { url: url.trim(), format })
    if (r) {
      setAdded(r.secret ? { secret: r.secret } : { chat: format })
      setUrl('')
    }
  }

  return (
    <div className="divide-y">
      {/* (A board's Telegram bot has a box of its own, below: see TelegramBots.) */}
      {loaded.webhooks.filter(notTelegram).map((h) => (
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
              {isChat(h.format) && `${WEBHOOK_FORMAT_NAMES[h.format]} · `}
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Send to</span>
          <Select
            value={format}
            onValueChange={(v) => {
              setFormat(v as WebhookFormat)
              setAdded(null)
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Send to">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEBHOOK_FORMATS.filter((f) => f !== 'telegram').map((f) => {
                const FormatIcon = FORMAT[f].icon
                return (
                  <SelectItem key={f} value={f}>
                    <FormatIcon /> {WEBHOOK_FORMAT_NAMES[f]}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={FORMAT[format].placeholder}
            aria-label={isChat(format) ? 'The channel’s address' : 'Webhook address'}
            className="h-8 min-w-36 flex-1"
          />
          <Button type="submit" size="sm" disabled={!url.trim()}>
            Add
          </Button>
        </div>
        {isChat(format) ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {FORMAT[format].where} The channel gets each change as a sentence. Card titles, people’s names and the start of comments are posted there,
            for everyone in that channel to read.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {loaded.mode === 'public' ? 'An https:// address on the internet.' : 'An http:// or https:// address, on the internet or your network.'}{' '}
            <a href="/api/docs#webhooks" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
              What’s sent <ArrowSquareOut className="size-3" />
            </a>
          </p>
        )}
        {added && 'secret' in added && (
          <SecretBox secret={added.secret} note="Added. Deliveries are signed with this secret, so the receiver can check they came from here." />
        )}
        {added && 'chat' in added && (
          <p className="rounded-lg border border-status-done/40 bg-status-done/8 p-3 text-xs">
            Added. Look in the channel: Kanbanto has said hello there in {WEBHOOK_FORMAT_NAMES[added.chat]}.
          </p>
        )}
      </form>
    </div>
  )
}

/**
 * A board's Telegram bots, in a box of their own in Board settings (owners): each is a bot its owner made at
 * @BotFather, connected to one chat, which gets the board's news and can add cards. Adding one takes the bot's token.
 * Whether boards may have them is a platform admin's switch, apart from the one for webhooks.
 */
export function TelegramBots({ onOpen }: { onOpen: (id: string) => void }) {
  const { loaded, act } = useWebhooks()
  const [token, setToken] = useState('')

  if (!loaded) return <div className="h-16" />
  if (!loaded.telegramBots)
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Telegram bots are turned off on this site. A platform admin can turn them on (Platform console → Integrations).
      </p>
    )

  const add = async () => {
    // What comes back is the code that connects a chat to the bot, shown on the bot's own page.
    const r = await act<{ id: string; connect: TelegramConnect }>('POST', '', { token: token.trim(), format: 'telegram' })
    if (!r) return
    connecting.set(r.id, r.connect)
    setToken('')
    onOpen(r.id)
  }

  return (
    <div className="divide-y">
      {loaded.webhooks.map(
        (h) =>
          h.telegram && (
            <button
              key={h.id}
              type="button"
              onClick={() => onOpen(h.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50"
            >
              <StatusDot h={h} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">@{h.telegram.bot}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {h.telegram.problem ??
                    (!h.active
                      ? 'Paused'
                      : h.telegram.chat
                        ? `${h.telegram.chat.kind === 'group' ? `The group ${h.telegram.chat.name}` : `${h.telegram.chat.name}’s own chat with it`}${h.telegram.takesCards ? ' · messages there become cards' : ' · news only'}`
                        : 'Not connected to a chat yet')}
                </span>
              </span>
              <CaretRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ),
      )}
      <form
        className="space-y-1.5 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <div className="flex gap-2">
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="The bot’s token, like 123456789:AAH…"
            aria-label="The bot’s token"
            // (A bot's token is the bot: it isn't left readable on the screen, or remembered by the browser.)
            type="password"
            autoComplete="off"
            className="h-8"
          />
          <Button type="submit" size="sm" disabled={!token.trim()}>
            Add
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Make a bot in Telegram: open @BotFather, send /newbot, and paste the token it gives you here. Next you connect it to your own chat with it,
          or to a group. One bot serves one board.
        </p>
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
  const { base, loaded, load, act } = useWebhooks()
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
      <ArrowLeft className="size-3.5" /> {h?.telegram ? 'Telegram' : 'Webhooks'}
    </button>
  )
  if (!loaded) return header
  if (!h)
    return (
      <div className="space-y-3">
        {header}
        <p className="text-sm text-muted-foreground">This was deleted.</p>
      </div>
    )

  const chat = isChat(h.format)
  const test = async () => {
    const r = await act<{ ok: boolean; status: number | null; error: string | null }>('POST', `/${h.id}/test`)
    if (r?.ok) toast('Test delivered', { description: chat ? 'Look in the channel.' : `The address answered ${r.status}.` })
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
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">{h.telegram ? `@${h.telegram.bot}` : h.url}</span>
            {h.telegram ? (
              <span className="block text-[11px] text-muted-foreground">
                {h.telegram.chat
                  ? `A Telegram bot, connected to ${h.telegram.chat.kind === 'group' ? `the group ${h.telegram.chat.name}` : `${h.telegram.chat.name}’s own chat with it`}`
                  : 'A Telegram bot, not connected to a chat yet'}
              </span>
            ) : (
              chat && <span className="block text-[11px] text-muted-foreground">Sentences for a {WEBHOOK_FORMAT_NAMES[h.format]} channel</span>
            )}
          </span>
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
        {h.telegram && <TelegramBot h={h} act={act} reload={load} />}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void test()}>
            <PaperPlaneTilt /> Send a test
          </Button>
          {/* (A chat app checks no signature, so there's no secret to show.) */}
          {!chat && (
            <>
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
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-destructive hover:text-destructive"
            onClick={async () => {
              const sure = h.telegram
                ? 'Remove this bot from the board? Nothing more is sent to its chat, and messages there stop becoming cards.'
                : 'Delete this webhook? Nothing more is sent to it.'
              if (!confirm(sure)) return
              if (await act('DELETE', `/${h.id}`)) {
                toast(h.telegram ? 'Bot removed' : 'Webhook deleted')
                onBack()
              }
            }}
          >
            <Trash /> {h.telegram ? 'Remove' : 'Delete'}
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
                      {/* (A chat webhook's message, as words that wrap; anything else, the data as it went.) */}
                      {chat && chatWords(d.payload) !== null ? (
                        <pre className="max-h-56 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap">
                          {chatWords(d.payload)}
                        </pre>
                      ) : (
                        <pre className="max-h-56 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-snug">
                          {JSON.stringify(d.payload, null, 2)}
                        </pre>
                      )}
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

/**
 * A board's Telegram bot, on its webhook's page: connecting it to a chat (a code to send the bot, good for ten
 * minutes), whether what's sent in that chat becomes cards and in which list, and a new token after a leak.
 */
function TelegramBot({
  h,
  act,
  reload,
}: {
  h: WebhookView
  act: <T>(method: 'POST' | 'PATCH' | 'DELETE' | 'GET', path: string, body?: unknown) => Promise<T | null>
  reload: () => Promise<void>
}) {
  const { data } = useBoard()
  const bot = h.telegram!
  const [connect, setConnect] = useState<TelegramConnect | null>(() => connecting.get(h.id) ?? null)
  // The chat as it was when the code was made: once another one shows up, the code has been used.
  const [before] = useState(() => bot.chat?.name ?? null)
  const waiting = !!connect && (bot.chat?.name ?? null) === before

  // While a code is out, look every few seconds for the chat that used it.
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void reload(), 3000)
    return () => clearInterval(timer)
  }, [waiting, reload])
  useEffect(() => {
    if (connect && !waiting) connecting.delete(h.id)
  }, [connect, waiting, h.id])

  const newCode = async () => {
    const r = await act<{ connect: TelegramConnect }>('POST', `/${h.id}/telegram/code`)
    if (r) {
      connecting.set(h.id, r.connect)
      setConnect(r.connect)
    }
  }
  const set = (body: object) => act('PATCH', `/${h.id}/telegram`, body)
  const lists = data.columns.filter((c) => c.category !== 'done')

  return (
    <div className="space-y-3 border-b px-4 py-3 text-xs">
      {bot.problem && <p className="rounded-md border border-destructive/40 bg-destructive/8 p-2 text-destructive">{bot.problem}</p>}
      {waiting && connect ? (
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="font-medium">Connect a chat: send the bot this code, within {connect.minutes} minutes.</p>
          <p className="text-muted-foreground">
            The chat that sends it becomes this board’s: it gets the board’s news, and what is sent there can become cards. The buttons open Telegram
            with the code ready.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" className="gap-1.5">
              <a href={connect.privateLink} target="_blank" rel="noreferrer">
                <TelegramLogo /> My own chat with the bot
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={connect.groupLink} target="_blank" rel="noreferrer">
                <TelegramLogo /> A group…
              </a>
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={`/start ${connect.code}`}
              onFocus={(e) => e.target.select()}
              className="h-8 font-mono text-xs"
              aria-label="The message that connects a chat"
            />
            <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void copy(`/start ${connect.code}`, 'Message')}>
              <Copy /> Copy
            </Button>
          </div>
          <p className="text-muted-foreground">Or send that message to @{bot.bot} yourself. Waiting for it…</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-muted-foreground">
            {bot.chat
              ? connect
                ? `Connected to ${bot.chat.name}. Kanbanto has said hello there.`
                : `The board’s news goes to ${bot.chat.name}.`
              : 'No chat is connected, so nothing is sent yet.'}
          </span>
          <Button variant="outline" size="sm" onClick={() => void newCode()}>
            {bot.chat ? 'Connect another chat' : 'Connect a chat'}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <Switch checked={bot.takesCards} aria-label="Messages there become cards" onCheckedChange={(on) => void set({ takesCards: on })} />
          <span>Messages there become cards{bot.takesCards ? ' in' : ''}</span>
        </label>
        {bot.takesCards && (
          <Select
            value={bot.cardsTo && lists.some((c) => c.id === bot.cardsTo) ? bot.cardsTo : 'first'}
            onValueChange={(v) => void set({ cardsTo: v === 'first' ? null : v })}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="The list new cards go to">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="first">The first list</SelectItem>
              {lists.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <p className="text-muted-foreground">
        In your own chat with the bot, every message is a card. In a group, <span className="font-mono">/card Fix the sign-up page</span> is. Send{' '}
        <span className="font-mono">/help</span> in the chat for the rest.{' '}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={async () => {
            const token = prompt(`The new token of @${bot.bot}, from @BotFather (after /revoke). The chat stays connected.`)
            if (token?.trim() && (await set({ token: token.trim() }))) toast('New token saved')
          }}
        >
          Paste a new token
        </button>
      </p>
    </div>
  )
}
