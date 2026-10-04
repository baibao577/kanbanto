import { createHmac, randomBytes } from 'node:crypto'
import { newId } from '@kanbanto/model/ids'
import type { Change } from '@kanbanto/model/records'
import { and, asc, eq, lt, lte } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { fetch } from 'undici'
import { decrypt } from './crypto'
import type { Db } from './db'
import { users, webhookDeliveries, webhooks } from './db/schema'
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

export class Webhooks {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private log: FastifyBaseLogger | null = null

  private readonly db: Db
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

  constructor(db: Db) {
    this.db = db
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

  /** Queues an event for the board's active webhooks (if the site allows webhooks). */
  async emit(boardId: string, event: WebhookEvent, data: object) {
    const hooks = (
      await this.db
        .select({ id: webhooks.id, events: webhooks.events })
        .from(webhooks)
        .where(and(eq(webhooks.boardId, boardId), eq(webhooks.active, true)))
    ).filter((h) => !h.events || h.events.includes(event))
    if (!hooks.length || (await loadSettings(this.db)).webhooks === 'off') return
    const at = new Date().toISOString()
    await this.db.insert(webhookDeliveries).values(
      hooks.map((h) => {
        const id = newId()
        return { id, webhookId: h.id, event, payload: { event, delivery: id, at, ...data } }
      }),
    )
    if (this.timer) setImmediate(() => void this.process())
  }

  /** A command changed a board: what changed, who did it, and the board's new change number. */
  async boardChanged(boardId: string, e: { board: { id: string; name: string }; userId: string; command: string; seq: number; changes: Change[] }) {
    const [actor] = await this.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, e.userId))
    await this.emit(boardId, 'board.changed', {
      board: e.board,
      actor: actor ?? null,
      command: e.command,
      seq: e.seq,
      changes: e.changes.slice(0, MAX_CHANGES),
      ...(e.changes.length > MAX_CHANGES && { truncated: true }),
    })
  }

  /** Sends what's due now. Returns how many were tried. */
  async process(): Promise<number> {
    if (this.busy) return 0
    this.busy = true
    try {
      const due = await this.db
        .select({ d: webhookDeliveries, h: webhooks })
        .from(webhookDeliveries)
        .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
        .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date())))
        .orderBy(asc(webhookDeliveries.createdAt))
        .limit(200)
      if (!due.length) return 0
      const mode = (await loadSettings(this.db)).webhooks
      // A few per webhook each round, sent side by side: one board's slow or silent address holds back only its
      // own deliveries, never everyone's.
      const perHook = new Map<string, typeof due>()
      for (const row of due) {
        const mine = perHook.get(row.h.id) ?? []
        if (mine.length < 3 && perHook.size <= 20) perHook.set(row.h.id, [...mine, row])
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
    const payload = { event: 'ping', delivery: id, at: new Date().toISOString(), board }
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
      if (mode === 'off') throw new Error('Webhooks are turned off on this site.')
      if (!h.active) throw new Error('This webhook is paused.')
      checkWebhookUrl(h.url, mode)
      const res = await fetch(h.url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Kanbanto-Webhooks',
          'x-kanbanto-event': d.event,
          'x-kanbanto-delivery': d.id,
          'x-kanbanto-signature': sign(decrypt(h.secretEncrypted), body),
        },
        // An address that sends us elsewhere could point the server anywhere: redirects aren't followed.
        redirect: 'manual',
        dispatcher: mode === 'public' ? publicOnly : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      answer = await readStart(res)
      status = res.status
      if (status < 200 || status >= 300) error = `The address answered ${status}.`
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
    const payload = { ...(d.payload as object), delivery: id, at: new Date().toISOString(), resent_from: d.id }
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
