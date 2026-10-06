import {
  WEBHOOK_EVENTS,
  WEBHOOK_FORMATS,
  type AddressChatFormat,
  type ApiTokenView,
  type ChatFormat,
  type TelegramBotView,
  type WebhookDeliveryDetail,
  type WebhookEventName,
  type WebhookFormat,
  type WebhookView,
} from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { MAX_TOKENS, newApiToken } from '../auth/apiTokens'
import { requireAccess } from '../boards/access'
import { checkChatAddress } from '../chat/hosts'
import { decrypt, encrypt } from '../crypto'
import { apiTokens, telegramBots, webhookDeliveries, webhooks } from '../db/schema'
import { dbErrorCode } from '../errors'
import { HttpError, parse } from '../http'
import { loadSettings } from '../settings'
import { checkWebhookUrl, newWebhookSecret } from '../webhooks'
import { requireUser } from './auth'

const MAX_WEBHOOKS = 10
const ONE_BOARD = 'That bot is already connected to a board here. One bot serves one board: make another for this one at @BotFather.'

const botView = (b: typeof telegramBots.$inferSelect): TelegramBotView => ({
  bot: b.botName,
  chat: b.chatId !== null && b.chatKind ? { kind: b.chatKind, name: b.chatName ?? '' } : null,
  takesCards: b.takesCards,
  cardsTo: b.cardsTo,
  problem: b.problem,
})
const DAY = 24 * 60 * 60 * 1000

const tokenView = (t: typeof apiTokens.$inferSelect): ApiTokenView => ({
  id: t.id,
  name: t.name,
  scope: t.scope,
  hint: t.hint,
  createdAt: t.createdAt.toISOString(),
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  expiresAt: t.expiresAt?.toISOString() ?? null,
})

/** Which events a webhook gets: at least one. All of them is stored as null (and then includes events added later). */
const Events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Pick at least one kind of event to send.')
const eventsToStore = (events?: WebhookEventName[]) => (!events || WEBHOOK_EVENTS.every((e) => events.includes(e)) ? null : [...new Set(events)])

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // ── Your API tokens (Account settings; never reachable with a token) ─────────

  app.get('/account/tokens', async (req) => {
    const me = requireUser(req.user)
    const rows = await app.db.select().from(apiTokens).where(eq(apiTokens.userId, me.id)).orderBy(desc(apiTokens.createdAt))
    return { enabled: (await loadSettings(app.db)).apiTokens, tokens: rows.map(tokenView) }
  })

  /** Makes a token. The answer is the only time the token itself is shown. */
  app.post('/account/tokens', async (req) => {
    const me = requireUser(req.user)
    if (!(await loadSettings(app.db)).apiTokens)
      throw new HttpError(403, 'API tokens are turned off on this site. A platform admin can turn them on.')
    const body = parse(
      z.object({
        name: z.string().trim().min(1, 'Give the token a name, so you know what it’s for.').max(100),
        scope: z.enum(['read', 'write']),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
      }),
      req.body,
    )
    const [{ n }] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apiTokens)
      .where(eq(apiTokens.userId, me.id))
    if (n >= MAX_TOKENS) throw new HttpError(400, `You have ${MAX_TOKENS} tokens already. Delete one you don’t use first.`)
    const { token, hash, hint } = newApiToken()
    const [row] = await app.db
      .insert(apiTokens)
      .values({
        id: newId(),
        userId: me.id,
        name: body.name,
        tokenHash: hash,
        hint,
        scope: body.scope,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * DAY) : null,
      })
      .returning()
    return { token, ...tokenView(row) }
  })

  app.delete('/account/tokens/:tokenId', async (req) => {
    const me = requireUser(req.user)
    const { tokenId } = parse(z.object({ tokenId: z.uuid() }), req.params)
    await app.db.delete(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, me.id)))
    return { ok: true }
  })

  /**
   * The Telegram bots you connected to your own chat, on any board: the ones your reminders and mentions can come
   * through (for the Telegram switches under Notifications). First the one used when a card's board has none of its own.
   */
  app.get('/account/telegram', async (req) => {
    const me = requireUser(req.user)
    const own = await app.telegram.ownBots(me.id)
    return {
      allowed: await app.telegram.allowed(),
      bots: own.map((b) => ({ bot: b.bot.botName, board: b.board.name, inbox: b.board.inboxOf === me.id })),
    }
  })

  // ── A board's webhooks (its owners) ───────────────────────────────────────────

  const BoardParams = z.object({ id: z.string().min(1).max(100) })
  const HookParams = BoardParams.extend({ hookId: z.uuid() })

  /** The board (for an owner) and, with `hookId`, one of its webhooks. */
  const ownHook = async (req: { user: Parameters<typeof requireUser>[0]; params: unknown }) => {
    const { id, hookId } = parse(HookParams, req.params)
    const { board } = await requireAccess(app.db, requireUser(req.user), id, 'owner')
    const [hook] = await app.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, hookId), eq(webhooks.boardId, id)))
    if (!hook) throw new HttpError(404, 'That webhook no longer exists.')
    return { board, hook }
  }
  const modeFor = async () => {
    const mode = (await loadSettings(app.db)).webhooks
    if (mode === 'off') throw new HttpError(403, 'Webhooks are turned off on this site. A platform admin can turn them on.')
    return mode
  }

  app.get('/boards/:id/webhooks', async (req) => {
    const { id } = parse(BoardParams, req.params)
    await requireAccess(app.db, requireUser(req.user), id, 'owner')
    const hooks = await app.db.select().from(webhooks).where(eq(webhooks.boardId, id)).orderBy(webhooks.createdAt)
    const recent = hooks.length
      ? await app.db
          .select()
          .from(webhookDeliveries)
          .where(
            inArray(
              webhookDeliveries.webhookId,
              hooks.map((h) => h.id),
            ),
          )
          .orderBy(desc(webhookDeliveries.createdAt))
          .limit(hooks.length * 10)
      : []
    const bots = hooks.some((h) => h.format === 'telegram')
      ? await app.db
          .select()
          .from(telegramBots)
          .where(
            inArray(
              telegramBots.webhookId,
              hooks.map((h) => h.id),
            ),
          )
      : []
    const list: WebhookView[] = hooks.map((h) => ({
      id: h.id,
      url: h.url,
      format: h.format as WebhookFormat,
      ...(bots.some((b) => b.webhookId === h.id) && { telegram: botView(bots.find((b) => b.webhookId === h.id)!) }),
      active: h.active,
      events: (h.events ?? [...WEBHOOK_EVENTS]) as WebhookEventName[],
      createdAt: h.createdAt.toISOString(),
      lastDeliveryAt: h.lastDeliveryAt?.toISOString() ?? null,
      lastStatus: h.lastStatus,
      lastError: h.lastError,
      recent: recent
        .filter((d) => d.webhookId === h.id)
        .slice(0, 5)
        .map((d) => ({
          id: d.id,
          event: d.event,
          status: d.status,
          attempts: d.attempts,
          responseStatus: d.responseStatus,
          error: d.lastError,
          createdAt: d.createdAt.toISOString(),
        })),
    }))
    const settings = await loadSettings(app.db)
    return { mode: settings.webhooks, telegramBots: settings.telegramBots, webhooks: list }
  })

  /**
   * Checks a new address, in the way its format allows. Kanbanto's own data goes to an address that confirms it wants
   * it (where the site only sends to public addresses). A chat app can't confirm anything: its address has to be the
   * chat app's own there, and the channel is sent a first message, which has to be taken.
   */
  const checkAddress = async (format: 'json' | AddressChatFormat, url: string, board: { name: string }) => {
    const mode = await modeFor()
    checkWebhookUrl(url, mode)
    if (format === 'json') return () => app.webhooks.confirmAddress(url, mode)
    if (mode === 'public') checkChatAddress(format, url)
    return () => app.webhooks.greet(format, url, board, mode)
  }
  const chatOf = (hook: { format: string }) => (hook.format === 'json' ? null : (hook.format as ChatFormat))

  /**
   * Adds a webhook. With Kanbanto's own data as the format, its signing secret is in the answer (and can be shown
   * again later by the board's owners). One that sends to a chat app has none.
   */
  app.post('/boards/:id/webhooks', async (req) => {
    const { id } = parse(BoardParams, req.params)
    const me = requireUser(req.user)
    const { board } = await requireAccess(app.db, me, id, 'owner')
    const {
      url = '',
      token = '',
      events,
      format = 'json',
    } = parse(
      z.object({
        url: z.string().trim().max(2000).optional(),
        /** For Telegram, instead of an address: the token @BotFather gave for the board's bot. */
        token: z.string().trim().max(200).optional(),
        events: Events.optional(),
        format: z.enum(WEBHOOK_FORMATS).optional(),
      }),
      req.body,
    )
    const room = async () => {
      const [{ n }] = await app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(webhooks)
        .where(eq(webhooks.boardId, id))
      if (n >= MAX_WEBHOOKS) throw new HttpError(400, `A board can have up to ${MAX_WEBHOOKS} webhooks.`)
    }
    if (format === 'telegram') {
      await telegramOn()
      if (!token) throw new HttpError(400, 'Paste the token @BotFather gave for the bot.')
      const bot = await app.telegram.whoIs(token)
      const [taken] = await app.db.select({ id: telegramBots.webhookId }).from(telegramBots).where(eq(telegramBots.botId, bot.id))
      if (taken) throw new HttpError(409, ONE_BOARD)
      await room()
      const hookId = newId()
      try {
        await app.db.transaction(async (tx) => {
          await tx.insert(webhooks).values({
            id: hookId,
            boardId: id,
            url: `https://t.me/${bot.username}`,
            format,
            // (On someone's own Inbox, card changes and comments would only tell them what they just did themselves:
            // a bot there starts with reminders alone, and they can switch the rest on.)
            events: eventsToStore(events ?? (board.inboxOf ? ['reminder.due'] : undefined)),
            // (The token is what's kept secret here: it is the bot.)
            secretEncrypted: encrypt(token),
            createdBy: me.id,
          })
          await tx.insert(telegramBots).values({ webhookId: hookId, botId: bot.id, botName: bot.username })
        })
      } catch (e) {
        if (dbErrorCode(e) === '23505') throw new HttpError(409, ONE_BOARD)
        throw e
      }
      // Nothing is sent until a chat is connected: the code that does it is in the answer.
      return { id: hookId, connect: app.telegram.newCode(hookId, bot.username) }
    }
    if (!url) throw new HttpError(400, 'Enter the address to send changes to.')
    const confirm = await checkAddress(format, url, board)
    await room()
    await confirm()
    const secret = newWebhookSecret()
    const hookId = newId()
    await app.db
      .insert(webhooks)
      .values({ id: hookId, boardId: id, url, format, events: eventsToStore(events), secretEncrypted: encrypt(secret), createdBy: me.id })
    return format === 'json' ? { id: hookId, secret } : { id: hookId }
  })

  /** Pauses or resumes a webhook, or changes its address or what it's sent. (Its format stays what it was made with.) */
  app.patch('/boards/:id/webhooks/:hookId', async (req) => {
    const { board, hook } = await ownHook(req)
    const body = parse(
      z
        .object({ active: z.boolean(), url: z.string().trim().min(1).max(2000), events: Events })
        .partial()
        .strict(),
      req.body,
    )
    if (body.url !== undefined) {
      if (hook.format === 'telegram') throw new HttpError(400, 'A Telegram bot has no address to change. Connect another chat, or paste a new token.')
      const confirm = await checkAddress(hook.format as 'json' | AddressChatFormat, body.url, board)
      if (body.url !== hook.url) await confirm()
    }
    const { events, ...rest } = body
    const set = { ...rest, ...(events && { events: eventsToStore(events) }) }
    if (Object.keys(set).length) await app.db.update(webhooks).set(set).where(eq(webhooks.id, hook.id))
    if (hook.format === 'telegram') app.telegram.changed()
    return { ok: true }
  })

  // ── A board's Telegram bot (a webhook whose format is Telegram) ────────────────

  const telegramOn = async () => {
    if (!(await loadSettings(app.db)).telegramBots)
      throw new HttpError(403, 'Telegram bots are turned off on this site. A platform admin can turn them on.')
  }
  const ownBot = async (req: Parameters<typeof ownHook>[0]) => {
    const { board, hook } = await ownHook(req)
    const [bot] = await app.db.select().from(telegramBots).where(eq(telegramBots.webhookId, hook.id))
    if (!bot) throw new HttpError(404, 'That webhook isn’t a Telegram bot.')
    return { board, hook, bot }
  }

  /** A new code to connect a chat with: the first chat that sends it to the bot becomes the board's (in place of the one before). */
  app.post('/boards/:id/webhooks/:hookId/telegram/code', async (req) => {
    const { hook, bot } = await ownBot(req)
    await telegramOn()
    return { connect: app.telegram.newCode(hook.id, bot.botName) }
  })

  /**
   * Whether messages in the chat become cards, and in which list; or a new token for the same bot (after `/revoke`
   * at @BotFather): the chat stays connected.
   */
  app.patch('/boards/:id/webhooks/:hookId/telegram', async (req) => {
    const { board, hook, bot } = await ownBot(req)
    const body = parse(
      z
        .object({ takesCards: z.boolean(), cardsTo: z.string().min(1).max(100).nullable(), token: z.string().trim().min(1).max(200) })
        .partial()
        .strict(),
      req.body,
    )
    if (body.cardsTo) {
      const { data } = await app.engine.snapshot(board.id)
      if (!data.columns.some((c) => c.id === body.cardsTo)) throw new HttpError(400, 'That list is no longer on the board.')
    }
    if (body.token !== undefined) {
      await telegramOn()
      const now = await app.telegram.whoIs(body.token)
      if (now.id !== bot.botId) throw new HttpError(400, `That token is for another bot (@${now.username}). Paste the new token of @${bot.botName}.`)
      await app.db
        .update(webhooks)
        .set({ secretEncrypted: encrypt(body.token) })
        .where(eq(webhooks.id, hook.id))
    }
    const { token, ...rest } = body
    const set = { ...rest, ...(token !== undefined && { problem: null }) }
    if (Object.keys(set).length) await app.db.update(telegramBots).set(set).where(eq(telegramBots.webhookId, hook.id))
    if (body.takesCards !== undefined) await app.telegram.refreshMenu(hook.id)
    app.telegram.changed()
    return { ok: true }
  })

  const NO_SECRET = 'A webhook that sends to a chat app has no signing secret: nothing at that end checks one.'

  app.get('/boards/:id/webhooks/:hookId/secret', async (req) => {
    const { hook } = await ownHook(req)
    if (chatOf(hook)) throw new HttpError(400, NO_SECRET)
    return { secret: decrypt(hook.secretEncrypted) }
  })

  /** A webhook's delivery log (the last 50, or only the failed ones), in full. */
  app.get('/boards/:id/webhooks/:hookId/deliveries', async (req) => {
    const { hook } = await ownHook(req)
    const { failed } = parse(z.object({ failed: z.enum(['0', '1']).optional() }), req.query)
    const rows = await app.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.webhookId, hook.id), failed === '1' ? inArray(webhookDeliveries.status, ['failed', 'pending']) : undefined))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50)
    const deliveries: WebhookDeliveryDetail[] = rows.map((d) => ({
      id: d.id,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.lastError,
      createdAt: d.createdAt.toISOString(),
      payload: d.payload,
      response: d.responseBody,
      sentAt: d.sentAt?.toISOString() ?? null,
    }))
    return { deliveries }
  })

  /** Sends a delivery again, now (as a new delivery). */
  app.post('/boards/:id/webhooks/:hookId/deliveries/:deliveryId/resend', async (req) => {
    const { hook } = await ownHook(req)
    const { deliveryId } = parse(z.object({ deliveryId: z.uuid() }), req.params)
    const [d] = await app.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, hook.id)))
    if (!d) throw new HttpError(404, 'There’s no such delivery.')
    return app.webhooks.resend(d, hook)
  })

  /** A new signing secret: the old one stops working at once. */
  app.post('/boards/:id/webhooks/:hookId/secret', async (req) => {
    const { hook } = await ownHook(req)
    if (chatOf(hook)) throw new HttpError(400, NO_SECRET)
    const secret = newWebhookSecret()
    await app.db
      .update(webhooks)
      .set({ secretEncrypted: encrypt(secret) })
      .where(eq(webhooks.id, hook.id))
    return { secret }
  })

  /** Sends a test delivery now, and says how it went. */
  app.post('/boards/:id/webhooks/:hookId/test', async (req) => {
    const { board, hook } = await ownHook(req)
    if (hook.format !== 'telegram') await modeFor()
    return app.webhooks.ping(hook, { id: board.id, name: board.name })
  })

  app.delete('/boards/:id/webhooks/:hookId', async (req) => {
    const { hook } = await ownHook(req)
    await app.db.delete(webhooks).where(eq(webhooks.id, hook.id))
    if (hook.format === 'telegram') app.telegram.changed()
    return { ok: true }
  })
}
