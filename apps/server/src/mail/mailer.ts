import { newId } from '@kanbanto/model/ids'
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db, Tx } from '../db'
import { emailOutbox, emailSenders, users, type EmailKind } from '../db/schema'
import { loggable } from '../errors'
import { loadSettings } from '../settings'
import { senderFromRow, type Sender } from './senders'
import { renderEmail, type Brand, type EmailContent } from './templates'
import { SendError, type Transport } from './transport'

/** Account emails go first; board emails stop first when the budget runs low. */
const PRIORITY: Record<EmailKind, number> = { verify: 0, reset: 0, test: 0, notice: 0, invite: 1, digest: 1, reminder: 1 }
/** Board emails may use this share of the platform's budget, leaving the rest for sign-up and password emails. */
const BOARD_EMAIL_SHARE = 0.8
/** Board emails one person can send per hour, whatever key pays. */
const INVITES_PER_HOUR = 10
/** Board emails a brand-new account (less than a day old) may send with the site's email: keeps throwaway accounts from spamming. */
const NEW_ACCOUNT_INVITES = 5
const DAY_MS = 86_400_000
const MAX_ATTEMPTS = 5
const RETRY_MINUTES = [1, 5, 30, 120]

export type QueueResult =
  | { queued: true; via: 'platform' | 'own-key' }
  | {
      queued: false
      /** not-set-up: no platform email · budget: the platform's daily/monthly budget is used up ·
       * allowance: this person's monthly allowance is used up · rate-limit: too many in the last hour ·
       * new-account: a brand-new account has sent its first day's few */
      reason: 'not-set-up' | 'budget' | 'allowance' | 'rate-limit' | 'new-account'
    }

export const WHY_NOT_SENT: Record<Exclude<QueueResult, { queued: true }>['reason'], string> = {
  'not-set-up': 'Email isn’t set up on this site yet.',
  budget: 'The site has reached its email limit for now.',
  allowance: 'You’ve used this month’s invite emails. Connect your own email key (Account settings → Email sending) to send more.',
  'rate-limit': 'You’ve sent a lot of invites in the last hour. Try again later.',
  'new-account': `New accounts can send ${NEW_ACCOUNT_INVITES} invite emails on their first day. Share the invite link yourself for now.`,
}

export async function getBrand(db: Db | Tx): Promise<Brand> {
  const s = await loadSettings(db)
  return { name: s.brandName, color: s.brandColor, footer: s.emailFooter }
}

const startOfDay = () => {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}
const startOfMonth = () => {
  const d = startOfDay()
  d.setUTCDate(1)
  return d
}

/**
 * Sends email through an outbox: `queue` decides who pays (the requester's own key, else the platform's key
 * within budgets and allowances), renders the email and stores it; a worker sends queued emails and retries
 * failures. Nothing is ever sent with a key the email isn't entitled to.
 */
export class Mailer {
  private readonly db: Db
  readonly transport: Transport
  /** The platform's sender set on the server (SMTP_URL); it replaces the console's setting. */
  readonly serverSender: Sender | null
  private log: FastifyBaseLogger | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  /** Whether the platform can send email (then new accounts must confirm their email). */
  platformReady = false
  /** The site's address, remembered from requests (for links in emails sent by background jobs). */
  siteUrl: string | null = null

  constructor(db: Db, transport: Transport, serverSender: Sender | null = null) {
    this.db = db
    this.transport = transport
    this.serverSender = serverSender
  }

  /** Starts the background worker (checks for due emails every few seconds). */
  async start(log: FastifyBaseLogger, everyMs = 5000) {
    this.log = log
    await this.refresh()
    this.timer = setInterval(() => void this.process(), everyMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Re-reads whether the platform can send (after its key is set or removed). */
  async refresh() {
    const [row] = await this.db.select({ id: emailSenders.id }).from(emailSenders).where(isNull(emailSenders.userId))
    this.platformReady = !!this.serverSender || !!row
  }

  /** How `userId` sends (their own key), or the platform (null). */
  async senderFor(userId: string | null): Promise<Sender | null> {
    if (!userId && this.serverSender) return this.serverSender
    const [row] = await this.db
      .select()
      .from(emailSenders)
      .where(userId ? eq(emailSenders.userId, userId) : isNull(emailSenders.userId))
    return row ? senderFromRow(row) : null
  }

  /** Shows the provider's reason on the sender while it keeps failing, so its owner knows why. */
  private async markFailing(sender: Sender, error: string) {
    if (sender.fromServer) {
      sender.lastError = error
      sender.failingSince ??= new Date()
    } else
      await this.db
        .update(emailSenders)
        .set({ lastError: error, failingSince: sender.failingSince ?? new Date() })
        .where(eq(emailSenders.id, sender.id))
  }

  private async markWorking(sender: Sender) {
    if (!sender.failingSince) return
    if (sender.fromServer) {
      sender.lastError = null
      sender.failingSince = null
    } else await this.db.update(emailSenders).set({ failingSince: null, lastError: null }).where(eq(emailSenders.id, sender.id))
  }

  /** Emails sent (or waiting) with the platform's key since `since`, of priority ≤ `maxPriority`. */
  private async platformCount(since: Date) {
    const [{ n }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.usesOwnKey, false), inArray(emailOutbox.status, ['queued', 'sending', 'sent']), gte(emailOutbox.createdAt, since)))
    return n
  }

  /** How much of the platform's budget is used (for the Platform console). */
  async usage() {
    return { today: await this.platformCount(startOfDay()), month: await this.platformCount(startOfMonth()) }
  }

  /** Board emails `userId` has sent with the platform's key this month (or since `since`). */
  async allowanceUsed(userId: string, since = startOfMonth()) {
    const [{ n }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.requestedBy, userId),
          eq(emailOutbox.usesOwnKey, false),
          eq(emailOutbox.priority, 1),
          inArray(emailOutbox.status, ['queued', 'sending', 'sent']),
          gte(emailOutbox.createdAt, since),
        ),
      )
    return n
  }

  /**
   * Queues an email. Account emails (verify, reset) always use the platform's key. Board emails use the
   * requester's own key if they have a working one, else the platform's key within their allowance.
   * Returns whether it was queued, or why not (so the app can offer another way, like the share link).
   */
  async queue(opts: { kind: EmailKind; to: string; requestedBy: string | null; content: (brand: Brand) => EmailContent }): Promise<QueueResult> {
    const priority = PRIORITY[opts.kind]
    // Null means no limit (e.g. the site's own mail server).
    const settings = await loadSettings(this.db)
    const budgets = { daily: settings.emailDailyBudget, monthly: settings.emailMonthlyBudget }
    const allowance = settings.userMonthlyAllowance

    let usesOwnKey = false
    if (priority > 0 && opts.requestedBy) {
      const [{ n }] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.requestedBy, opts.requestedBy),
            eq(emailOutbox.priority, 1),
            gte(emailOutbox.createdAt, new Date(Date.now() - 3600_000)),
          ),
        )
      if (n >= INVITES_PER_HOUR) return { queued: false, reason: 'rate-limit' }
      const own = await this.senderFor(opts.requestedBy)
      usesOwnKey = !!own && !own.failingSince
    }

    if (!usesOwnKey) {
      if (!(await this.senderFor(null))) return { queued: false, reason: 'not-set-up' }
      if (priority > 0 && opts.requestedBy && allowance !== null && (await this.allowanceUsed(opts.requestedBy)) >= allowance)
        return { queued: false, reason: 'allowance' }
      if (priority > 0 && opts.requestedBy) {
        const [u] = await this.db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, opts.requestedBy))
        if (u && Date.now() - u.createdAt.getTime() < DAY_MS && (await this.allowanceUsed(opts.requestedBy, u.createdAt)) >= NEW_ACCOUNT_INVITES)
          return { queued: false, reason: 'new-account' }
      }
      if (budgets.daily !== null || budgets.monthly !== null) {
        const share = priority > 0 ? BOARD_EMAIL_SHARE : 1
        const over = (used: number, limit: number | null) => limit !== null && used >= Math.floor(limit * share)
        const { today, month } = await this.usage()
        if (over(today, budgets.daily) || over(month, budgets.monthly)) return { queued: false, reason: 'budget' }
      }
    }

    const brand = await getBrand(this.db)
    const email = await renderEmail(brand, opts.content(brand))
    await this.db.insert(emailOutbox).values({
      id: newId(),
      kind: opts.kind,
      priority,
      toAddress: opts.to,
      ...email,
      requestedBy: opts.requestedBy,
      usesOwnKey,
    })
    setImmediate(() => void this.process())
    return { queued: true, via: usesOwnKey ? 'own-key' : 'platform' }
  }

  /**
   * Sends due emails, a few at a time. Safe to call from several processes (rows are claimed with SKIP LOCKED);
   * a call while a pass is running waits for it and then makes another pass, so everything due is sent when it returns.
   */
  process(): Promise<void> {
    if (this.inflight) return this.inflight.then(() => this.process())
    this.inflight = this.pass().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async pass() {
    try {
      // Emails stuck "sending" (the server stopped mid-send) go back in the queue.
      await this.db
        .update(emailOutbox)
        .set({ status: 'queued' })
        .where(and(eq(emailOutbox.status, 'sending'), lte(emailOutbox.nextAttemptAt, new Date(Date.now() - 10 * 60_000))))
      for (;;) {
        const batch = await this.db.transaction(async (tx) => {
          const due = await tx
            .select()
            .from(emailOutbox)
            .where(and(eq(emailOutbox.status, 'queued'), lte(emailOutbox.nextAttemptAt, new Date())))
            .orderBy(emailOutbox.priority, emailOutbox.createdAt)
            .limit(10)
            .for('update', { skipLocked: true })
          if (due.length)
            await tx
              .update(emailOutbox)
              .set({ status: 'sending', attempts: sql`${emailOutbox.attempts} + 1`, nextAttemptAt: new Date() })
              .where(
                inArray(
                  emailOutbox.id,
                  due.map((d) => d.id),
                ),
              )
          return due
        })
        if (!batch.length) return
        for (const row of batch) await this.deliver(row)
      }
    } catch (e) {
      this.log?.error({ err: loggable(e) }, 'email outbox')
    }
  }

  private async deliver(row: typeof emailOutbox.$inferSelect) {
    const sender = await this.senderFor(row.usesOwnKey ? row.requestedBy : null)
    if (!sender) return this.finish(row, 'failed', 'The email key was removed before it could be sent.')
    try {
      const { id } = await this.transport.send(sender.credentials(), {
        from: sender.from,
        to: row.toAddress,
        subject: row.subject,
        html: row.html,
        text: row.text,
      })
      // Only what budgets need is kept: the email itself (which may hold a sign-in link) isn't.
      await this.db
        .update(emailOutbox)
        .set({ status: 'sent', sentAt: new Date(), providerId: id, lastError: null, html: '', text: '' })
        .where(eq(emailOutbox.id, row.id))
      await this.markWorking(sender)
    } catch (e) {
      const err = e instanceof SendError ? e : new SendError(0, e instanceof Error ? e.message : 'Unknown error')
      // Never log the key; the provider's message is safe.
      this.log?.warn({ email: row.id, status: err.status, error: err.message }, 'email not sent')
      if (err.permanent) {
        // Bad key or password, unverified domain…: flag the sender so its owner sees why, and stop retrying.
        await this.markFailing(sender, err.message)
        return this.finish(row, 'failed', err.message)
      }
      if (row.attempts + 1 >= MAX_ATTEMPTS) return this.finish(row, 'failed', err.message)
      const wait = RETRY_MINUTES[Math.min(row.attempts, RETRY_MINUTES.length - 1)]
      await this.db
        .update(emailOutbox)
        .set({ status: 'queued', lastError: err.message, nextAttemptAt: new Date(Date.now() + wait * 60_000) })
        .where(eq(emailOutbox.id, row.id))
    }
  }

  private async finish(row: { id: string }, status: 'failed', error: string) {
    await this.db.update(emailOutbox).set({ status, lastError: error, html: '', text: '' }).where(eq(emailOutbox.id, row.id))
  }

  /** Deletes emails older than 60 days (their counts no longer matter). */
  async prune() {
    await this.db.delete(emailOutbox).where(lte(emailOutbox.createdAt, new Date(Date.now() - 60 * 86_400_000)))
  }
}
