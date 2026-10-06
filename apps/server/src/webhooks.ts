import { createHmac, randomBytes } from 'node:crypto'
import type { ActivityItem } from '@kanbanto/model/activity'
import { WEBHOOK_FORMAT_NAMES, type AddressChatFormat, type ChatFormat } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import type { Change } from '@kanbanto/model/records'
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { fetch } from 'undici'
import { taskUrl } from './calendar/items'
import { changeMessage, chatBody, helloMessage, testMessage, type ChatMessage } from './chat/format'
import { checkChatAddress } from './chat/hosts'
import { decrypt } from './crypto'
import type { Db } from './db'
import { telegramBots, users, webhookDeliveries, webhooks } from './db/schema'
import { HttpError } from './http'
import { loadSettings } from './settings'
import { assertPublicEndpoint, PrivateAddressError, publicOnly } from './storage/egress'

/**
 * Webhooks: each change to a board (and each new comment) is POSTed as JSON to the board's webhook addresses, signed
 * with the webhook's secret:
 *
 *   X-Kanbanto-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>
 *
 * Deliveries wait in a queue (webhook_deliveries) and are retried with growing delays when the address doesn't answer
 * with 2xx. Platform admins choose whether webhooks may go to public addresses only, or anywhere (a company network).
 *
 * A webhook with a chat format (Slack, Google Chat, Microsoft Teams, Discord) is sent the same events as text the
 * chat app shows in a channel (see chat/format.ts), unsigned: there's nobody at that end to check a signature.
 */

export type WebhookEvent = 'board.changed' | 'comment.added' | 'reminder.due' | 'ping'
export type WebhookMode = 'off' | 'public' | 'any'

/** Delays before each retry, in minutes: six tries over about eight hours, then the delivery is given up. */
const RETRY_MINUTES = [1, 5, 30, 120, 360]
const TIMEOUT_MS = 10_000
/** Big changes (undoing a large delete) are cut down to this many records in the payload. */
const MAX_CHANGES = 200
const KEEP_DAYS = 7

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`

/** Checks an address for a new or changed webhook. */
export function checkWebhookUrl(url: string, mode: WebhookMode) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new HttpError(400, 'Enter the full address, starting with https://')
  }
  if (u.protocol !== 'https:' && !(mode === 'any' && u.protocol === 'http:'))
    throw new HttpError(400, mode === 'any' ? 'Use an http:// or https:// address.' : 'Use an https:// address.')
  if (u.username || u.password) throw new HttpError(400, 'Leave any user name and password out of the address.')
  if (mode === 'public')
    try {
      assertPublicEndpoint(url)
    } catch (e) {
      if (e instanceof PrivateAddressError) throw new HttpError(400, `${e.message}: this site only sends webhooks to public addresses.`)
      throw e
    }
}

/** The signature header for `body` (receivers recompute it to check the delivery came from here). */
export function sign(secret: string, body: string, time = Math.floor(Date.now() / 1000)) {
  return `t=${time},v1=${createHmac('sha256', secret).update(`${time}.${body}`).digest('hex')}`
}

type Hook = typeof webhooks.$inferSelect
type Delivery = typeof webhookDeliveries.$inferSelect

const chatFormat = (h: { format: string }): ChatFormat | null => (h.format === 'json' ? null : (h.format as ChatFormat))
const HEADERS = { 'content-type': 'application/json', 'user-agent': 'Kanbanto-Webhooks' }

export class Webhooks {
  private timer: ReturnType<typeof setInterval> | null = null
  private queueing = new Set<Promise<unknown>>()
  private busy = false
  private log: FastifyBaseLogger | null = null

  private readonly db: Db
  /** The site's own address, for links to cards in chat messages (null while it isn't known). */
  private readonly site: () => string | null
  /** How a delivery is sent (replaced in tests). `mode`: "public" only connects to public addresses. */
  post: (url: string, body: string, headers: Record<string, string>, mode: WebhookMode) => Promise<{ status: number; text: string | null }> = async (
    url,
    body,
    headers,
    mode,
  ) => {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers,
      // An address that sends us elsewhere could point the server anywhere: redirects aren't followed.
      redirect: 'manual',
      dispatcher: mode === 'public' ? publicOnly : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: res.status, text: await readStart(res) }
  }
  /** How a delivery goes through a board's Telegram bot (set by the app: see telegram/bots.ts). */
  telegram: ((hook: Hook, payload: object) => Promise<{ status: number; text: string | null }>) | null = null
  /** How the address check is sent (replaced in tests). */
  ask: (url: string, body: string) => Promise<{ status: number; text: string }> = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'user-agent': 'Kanbanto-Webhooks', 'x-kanbanto-event': 'verify' },
      redirect: 'manual',
      dispatcher: publicOnly,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: res.status, text: (await readStart(res)) ?? '' }
  }

  /**
   * Checks that an address means to receive this board's events, before it's saved: it's sent a one-time code
   * (`{ "event": "verify", "challenge": "…" }`) and must answer 2xx with the code in its reply. So a webhook can't
   * be pointed at somebody else's server. Where a platform admin allows any address (internal tools, board owners
   * they trust), it isn't asked.
   */
  async confirmAddress(url: string, mode: WebhookMode) {
    if (mode !== 'public') return
    const challenge = randomBytes(18).toString('base64url')
    let answer: { status: number; text: string }
    try {
      answer = await this.ask(url, JSON.stringify({ event: 'verify', challenge }))
    } catch {
      throw new HttpError(
        400,
        'That address didn’t answer. It has to be reachable, and reply to the check Kanbanto sends (see the API docs, “Webhooks”).',
      )
    }
    if (answer.status < 200 || answer.status >= 300 || !answer.text.includes(challenge))
      throw new HttpError(
        400,
        'That address didn’t confirm it wants these: it has to answer the check with the code it was sent (see the API docs, “Webhooks”).',
      )
  }

  /**
   * A chat app can't answer the check above, so its channel is sent a first message instead: the webhook is only
   * saved when the chat app takes it.
   */
  async greet(format: AddressChatFormat, url: string, board: { name: string }, mode: WebhookMode) {
    const app = WEBHOOK_FORMAT_NAMES[format]
    let answer: { status: number }
    try {
      answer = await this.post(url, JSON.stringify(chatBody(format, helloMessage(board.name))), HEADERS, mode)
    } catch {
      throw new HttpError(400, `Couldn’t reach that address. Copy it again from ${app}.`)
    }
    if (answer.status < 200 || answer.status >= 300)
      throw new HttpError(400, `${app} didn’t take a message at that address (it answered ${answer.status}). Copy the address again from ${app}.`)
  }

  constructor(db: Db, site: () => string | null = () => null) {
    this.db = db
    this.site = site
  }

  /** A card's address, for a link in a chat message. */
  cardUrl(boardId: string, taskId: string): string | null {
    const site = this.site()
    return site ? taskUrl(site, boardId, taskId) : null
  }

  /**
   * Queues in the background, after the request that caused it has been answered: `work` is remembered until it's
   * done, so `queued` can wait for it. (Whoever starts it says what happens when it fails.)
   */
  later(work: Promise<unknown>) {
    const done = work.catch(() => {}).finally(() => this.queueing.delete(done))
    this.queueing.add(done)
  }

  /** Everything that was being queued in the background is in the queue (tests wait for this before sending). */
  async queued() {
    while (this.queueing.size) await Promise.all(this.queueing)
  }

  /** Sends due deliveries in the background (the server does this; tests call `process` themselves). */
  start(log: FastifyBaseLogger, everyMs = 5000) {
    this.log = log
    this.timer = setInterval(() => void this.process(), everyMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Queues an event for the board's active webhooks (if the site allows webhooks). `words`: the event as a chat
   * message, for the webhooks that send to a chat app; when it has nothing to say, they're sent nothing.
   */
  async emit(boardId: string, event: WebhookEvent, data: object, words?: () => ChatMessage | null, except?: string | string[]) {
    const hooks = (
      await this.db
        .select({ id: webhooks.id, events: webhooks.events, format: webhooks.format, chat: telegramBots.chatId })
        .from(webhooks)
        .leftJoin(telegramBots, eq(telegramBots.webhookId, webhooks.id))
        .where(and(eq(webhooks.boardId, boardId), eq(webhooks.active, true)))
    )
      .filter((h) => !h.events || h.events.includes(event))
      // (A Telegram bot that no chat is connected to yet has nowhere to say it; and a chat isn't told what it has
      // been told already: what was just done from that chat, or someone's own news sent there a moment ago.)
      .filter((h) => h.format !== 'telegram' || (h.chat !== null && !([] as (string | undefined)[]).concat(except).includes(h.id)))
    // Each kind goes by its own switch for the site: webhooks to addresses, and boards' Telegram bots.
    const site = hooks.length ? await loadSettings(this.db) : null
    const allowed = hooks.filter((h) => (h.format === 'telegram' ? site!.telegramBots : site!.webhooks !== 'off'))
    if (!allowed.length) return
    const at = new Date().toISOString()
    let message: ChatMessage | null | undefined
    const rows = allowed.flatMap((h) => {
      const id = newId()
      const format = chatFormat(h)
      if (!format) return [{ id, webhookId: h.id, event, payload: { event, delivery: id, at, ...data } as object }]
      // What's kept (and shown in the log) is the message itself, as the chat app gets it.
      if (message === undefined) message = words?.() ?? null
      return message ? [{ id, webhookId: h.id, event, payload: chatBody(format, message) }] : []
    })
    if (!rows.length) return
    await this.db.insert(webhookDeliveries).values(rows)
    if (this.timer) setImmediate(() => void this.process())
  }

  /**
   * A command changed a board: what changed, who did it, and the board's new change number. `items`: the same in
   * words, as the activity log has it (none when things were only reordered).
   */
  async boardChanged(
    boardId: string,
    e: {
      board: { id: string; name: string }
      userId: string
      command: string
      seq: number
      changes: Change[]
      items: ActivityItem[]
      mutationId?: string
    },
  ) {
    const [actor] = await this.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, e.userId))
    await this.emit(
      boardId,
      'board.changed',
      {
        board: e.board,
        actor: actor ?? null,
        command: e.command,
        seq: e.seq,
        changes: e.changes.slice(0, MAX_CHANGES),
        ...(e.changes.length > MAX_CHANGES && { truncated: true }),
      },
      () =>
        changeMessage({ actor: actor?.name ?? null, board: e.board.name, items: e.items, changes: e.changes }, (taskId) =>
          this.cardUrl(boardId, taskId),
        ),
      // (A change made from a board's Telegram chat carries that bot's webhook in its id: see telegram/cards.ts.)
      /^tg:([0-9a-f-]{36}):/.exec(e.mutationId ?? '')?.[1],
    )
  }

  /** Sends what's due now. Returns how many were tried. */
  async process(): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    try {
      // The oldest few due for each webhook (not the oldest of all: one webhook's backlog would be the whole round).
      const picked = await this.db.execute<{ id: string }>(sql`
        select id from (
          select d.id, d.created_at, row_number() over (partition by d.webhook_id order by d.created_at) as n
          from ${webhookDeliveries} d
          where d.status = 'pending' and d.next_attempt_at <= now()
        ) due
        where n <= 3
        order by created_at
        limit 60`)
      const ids = [...picked].map((r) => r.id)
      if (!ids.length) return 0
      const due = await this.db
        .select({ d: webhookDeliveries, h: webhooks })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
        // (Due by the database's clock, which stamped them when they were queued: the server's may be a little behind.)
        .where(and(inArray(webhookDeliveries.id, ids), eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, sql`now()`)))
        .orderBy(asc(webhookDeliveries.createdAt))
      if (!due.length) return 0
      const mode = (await loadSettings(this.db)).webhooks
      // A few per webhook each round, sent side by side: one board's slow or silent address holds back only its
      // own deliveries, never everyone's.
      const perHook = new Map<string, typeof due>()
      for (const row of due) {
        const mine = perHook.get(row.h.id) ?? []
        perHook.set(row.h.id, [...mine, row])
      }
      // (One webhook's own deliveries still go in order.)
      await Promise.all(
        [...perHook.values()].map(async (rows) => {
          for (const { d, h } of rows) await this.deliver(d, h, mode)
        }),
      )
      return [...perHook.values()].reduce((n, rows) => n + rows.length, 0)
    } catch (e) {
      this.log?.error({ err: e instanceof Error ? e.message : e }, 'webhook deliveries')
      return 0
    } finally {
      this.busy = false
    }
  }

  /** Sends a test ("ping") delivery right away, and says how it went. */
  async ping(hook: Hook, board: { id: string; name: string }) {
    const id = newId()
    const format = chatFormat(hook)
    const payload = format ? chatBody(format, testMessage(board.name)) : { event: 'ping', delivery: id, at: new Date().toISOString(), board }
    const [d] = await this.db.insert(webhookDeliveries).values({ id, webhookId: hook.id, event: 'ping', payload }).returning()
    return this.deliver(d, hook, (await loadSettings(this.db)).webhooks, { retry: false })
  }

  /** One try at one delivery. It's retried later unless it worked, or it was the last try. */
  private async deliver(d: Delivery, h: Hook, mode: WebhookMode, { retry = true } = {}) {
    const body = JSON.stringify(d.payload)
    let status: number | null = null
    let error: string | null = null
    let answer: string | null = null
    try {
      const format = chatFormat(h)
      // (A Telegram bot goes by its own switch for the site, checked where it's sent: see telegram/bots.ts.)
      if (mode === 'off' && format !== 'telegram') throw new Error('Webhooks are turned off on this site.')
      if (!h.active) throw new Error(format === 'telegram' ? 'This bot is paused.' : 'This webhook is paused.')
      let res: { status: number; text: string | null }
      if (format === 'telegram') {
        if (!this.telegram) throw new Error('Telegram bots aren’t set up on this server.')
        res = await this.telegram(h, d.payload as object)
      } else {
        checkWebhookUrl(h.url, mode)
        if (format && mode === 'public') checkChatAddress(format, h.url)
        res = await this.post(
          h.url,
          body,
          // (A chat app gets the message and nothing else: it has no use for the event's name or a signature.)
          format
            ? HEADERS
            : {
                ...HEADERS,
                'x-kanbanto-event': d.event,
                'x-kanbanto-delivery': d.id,
                'x-kanbanto-signature': sign(decrypt(h.secretEncrypted), body),
              },
          mode,
        )
      }
      answer = res.text
      status = res.status
      if (status < 200 || status >= 300)
        error = format === 'telegram' ? `Telegram answered ${status}${answer ? `: ${answer}` : '.'}` : `The address answered ${status}.`
    } catch (e) {
      const cause = e instanceof PrivateAddressError ? e : (e as { cause?: unknown })?.cause
      error =
        cause instanceof PrivateAddressError
          ? `${cause.message}: this site only sends webhooks to public addresses.`
          : e instanceof HttpError
            ? e.message
            : (e as { name?: string })?.name === 'TimeoutError'
              ? `No answer within ${TIMEOUT_MS / 1000} seconds.`
              : `Couldn’t reach the address (${(cause as { code?: string })?.code ?? (e instanceof Error ? e.message : 'unknown error')}).`
    }
    const attempts = d.attempts + 1
    const ok = !error
    const last = !retry || attempts > RETRY_MINUTES.length
    const now = new Date()
    await this.db
      .update(webhookDeliveries)
      .set({
        attempts,
        responseStatus: status,
        responseBody: answer,
        lastError: error,
        status: ok ? 'sent' : last ? 'failed' : 'pending',
        sentAt: ok ? now : null,
        nextAttemptAt: ok || last ? now : new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60_000),
      })
      .where(eq(webhookDeliveries.id, d.id))
    await this.db.update(webhooks).set({ lastDeliveryAt: now, lastStatus: status, lastError: error }).where(eq(webhooks.id, h.id))
    return { ok, status, error }
  }

  /** Sends a delivery again (a new one, with the same event and data), right away. */
  async resend(d: Delivery, h: Hook) {
    const id = newId()
    // (A chat message goes again exactly as it was: the chat app may refuse a body with anything added.)
    const payload = chatFormat(h)
      ? (d.payload as object)
      : { ...(d.payload as object), delivery: id, at: new Date().toISOString(), resent_from: d.id }
    const [fresh] = await this.db.insert(webhookDeliveries).values({ id, webhookId: h.id, event: d.event, payload }).returning()
    return this.deliver(fresh, h, (await loadSettings(this.db)).webhooks, { retry: true })
  }

  /** Deliveries are kept a week, for the webhook's recent log. */
  async prune() {
    await this.db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000)))
  }
}

/** The start of a reply (up to 2 KB of text), for the delivery log. */
async function readStart(res: Response): Promise<string | null> {
  // Only that much is read: the rest of a long (or endless) reply is dropped, not held in memory.
  const reader = res.body?.getReader()
  if (!reader) return null
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (size < 4096) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.byteLength
    }
  } catch {
    // A reply cut short still shows what arrived.
  } finally {
    await reader.cancel().catch(() => {})
  }
  const text = new TextDecoder().decode(Buffer.concat(parts).subarray(0, 4096))
  return text ? text.slice(0, 2048) : null
}
