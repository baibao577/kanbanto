import { createHash, randomBytes } from 'node:crypto'
import type { TelegramConnect } from '@kanbanto/model/api'
import { and, eq, isNotNull, lt } from 'drizzle-orm'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { telegramHtml as h, telegramOpen, telegramText } from '../chat/format'
import { decrypt } from '../crypto'
import { boards, telegramBots, telegramCards, webhooks } from '../db/schema'
import { HttpError } from '../http'
import { loadSettings } from '../settings'
import { nameOf, TelegramError, type TelegramApi, type TgMessage, type TgUpdate } from './api'
import { KEEP_DAYS, menuFor, onButton, onEdit, onMessage, type Ctx } from './cards'
import { helpText } from './help'

/**
 * Boards' own Telegram bots. A board's owner makes a bot at @BotFather and adds it to the board as a webhook whose
 * format is Telegram; the bot is then connected to one chat (the owner's own chat with it, or a group) by sending it
 * a one-time code. That chat gets the board's news through the webhook queue, and what's sent there can become cards
 * (see cards.ts). One bot serves one board: Telegram lets only one place read a bot's messages.
 *
 * New messages are asked for ("long polling"), not sent to this server, so a site needs no address Telegram can
 * reach. Each bot that is waiting to be connected, or takes cards, holds one request to Telegram open; where
 * reading left off is saved after every message, so a restart loses none.
 */

/** A connecting code works this long. */
export const CODE_MINUTES = 10
const TOKEN_GONE = 'Telegram no longer accepts this bot’s token. Paste a new one from @BotFather.'
const READ_ELSEWHERE = 'Another server is reading this bot’s messages. A bot can be connected in one place only.'
const REMOVED = 'The bot was removed from the chat. Add it again, or connect another chat.'
/** Seconds to wait before asking again after Telegram couldn't be reached, growing. */
const BACKOFF = [1, 2, 5, 15, 30, 60]
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), done()), { once: true })
  })

export class Telegram {
  /** Telegram itself (a stand-in in tests). */
  api: TelegramApi
  private readonly app: FastifyInstance
  private readonly site: () => string | null
  /** Codes that connect a chat to a bot, by their hash. In memory: a restart just means asking for a new one. */
  private codes = new Map<string, { webhookId: string; expires: number }>()
  private readers = new Map<string, AbortController>()
  /** Bots set up since this server started (commands listed, no webhook of Telegram's in the way). */
  private ready = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private log: FastifyBaseLogger | null = null

  constructor(app: FastifyInstance, api: TelegramApi, site: () => string | null) {
    this.app = app
    this.api = api
    this.site = site
  }

  // ── Adding a bot ────────────────────────────────────────────────────────────

  /** Which bot a token is for. Refuses one Telegram doesn't know. */
  async whoIs(token: string): Promise<{ id: number; username: string }> {
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new HttpError(400, 'That isn’t a bot’s token. @BotFather gives one that looks like 123456789:AAH…')
    try {
      const me = await this.api.call<{ id: number; username?: string }>(token, 'getMe')
      return { id: me.id, username: me.username ?? String(me.id) }
    } catch (e) {
      if (e instanceof TelegramError && e.status === 0) throw new HttpError(502, 'Telegram couldn’t be reached. Try again in a moment.')
      throw new HttpError(400, 'Telegram doesn’t know that token. Copy it again from @BotFather.')
    }
  }

  /** A new code that connects a chat to this bot: the first chat to send it becomes the board's. Any earlier code stops working. */
  newCode(webhookId: string, botName: string): TelegramConnect {
    const now = Date.now()
    for (const [key, c] of this.codes) if (c.expires <= now || c.webhookId === webhookId) this.codes.delete(key)
    const code = randomBytes(9).toString('base64url')
    this.codes.set(hash(code), { webhookId, expires: now + CODE_MINUTES * 60_000 })
    this.changed()
    return {
      code,
      privateLink: `https://t.me/${botName}?start=${code}`,
      groupLink: `https://t.me/${botName}?startgroup=${code}`,
      minutes: CODE_MINUTES,
    }
  }
  private waiting(webhookId: string) {
    const now = Date.now()
    return [...this.codes.values()].some((c) => c.webhookId === webhookId && c.expires > now)
  }
  /** (Tests can make a code run out, and start from nothing.) */
  expireCodes() {
    for (const c of this.codes.values()) c.expires = 0
  }
  forget() {
    this.codes.clear()
    this.ready.clear()
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /** A webhook delivery through the board's bot: the message, to the chat it's connected to. */
  async deliver(hook: typeof webhooks.$inferSelect, payload: object): Promise<{ status: number; text: string | null }> {
    if (!(await this.allowed())) throw new HttpError(403, 'Telegram bots are turned off on this site.')
    const [bot] = await this.app.db.select().from(telegramBots).where(eq(telegramBots.webhookId, hook.id))
    if (!bot?.chatId) throw new HttpError(409, 'No chat is connected to this bot yet.')
    try {
      await this.api.call(decrypt(hook.secretEncrypted), 'sendMessage', { chat_id: bot.chatId, ...payload })
      return { status: 200, text: '{"ok":true}' }
    } catch (e) {
      if (!(e instanceof TelegramError) || e.status === 0) throw e
      if (e.migrateTo) await this.app.db.update(telegramBots).set({ chatId: e.migrateTo }).where(eq(telegramBots.webhookId, hook.id))
      return { status: e.status, text: e.message }
    }
  }

  /**
   * The bots someone connected to their own chat (their own private chat with a bot they added), each with the board
   * it's on: the ones that can tell them their own news, each about its own board. Oldest first.
   */
  async ownBots(userId: string) {
    return this.app.db
      .select({ hook: webhooks, bot: telegramBots, board: { id: boards.id, name: boards.name, inboxOf: boards.inboxOf } })
      .from(telegramBots)
      .innerJoin(webhooks, eq(webhooks.id, telegramBots.webhookId))
      .innerJoin(boards, eq(boards.id, webhooks.boardId))
      .where(and(eq(webhooks.createdBy, userId), eq(webhooks.active, true), eq(telegramBots.chatKind, 'private'), isNotNull(telegramBots.chatId)))
      .orderBy(webhooks.createdAt)
  }

  /**
   * Someone's own news (a reminder, a mention) about a card on `about.boardId`, through a bot they connected to their
   * own chat on that board, and only such a bot: a bot's reach is the board it was added to, so a card on a board
   * where they have none isn't told on Telegram. Returns that bot's webhook when it was sent (so the same chat isn't
   * also sent it as the board's news), else null.
   *
   * `about.covered`: the board's own news of the same thing. When the bot already sends that, nothing more is sent:
   * the chat has it.
   */
  async toPerson(
    userId: string,
    message: { title: string; body?: string; url?: string | null },
    about: { boardId?: string; covered?: string } = {},
  ): Promise<string | null> {
    if (!about.boardId || !(await this.allowed())) return null
    const row = (await this.ownBots(userId)).find((r) => r.board.id === about.boardId)
    if (!row) return null
    if (about.covered && (!row.hook.events || row.hook.events.includes(about.covered))) return null
    const html = [`<b>${h(message.title)}</b>`, message.body && h(message.body), telegramOpen(message.url ?? null)].filter(Boolean).join('\n')
    await this.api.call(decrypt(row.hook.secretEncrypted), 'sendMessage', { chat_id: row.bot.chatId, ...telegramText(html) })
    return row.hook.id
  }

  /** Boards may have Telegram bots on this site (a platform admin's switch, of its own: not the one for webhooks). */
  async allowed() {
    return (await loadSettings(this.app.db)).telegramBots
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** Reads bots' messages in the background (the server does this; tests call `poll` themselves). */
  start(log: FastifyBaseLogger) {
    this.log = log
    this.timer = setInterval(() => void this.sync(), 20_000)
    void this.sync()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const r of this.readers.values()) r.abort()
    this.readers.clear()
  }

  /** Something about a bot changed (added, connected, paused, a new code): look again at which ones need reading. */
  changed() {
    if (this.timer) setImmediate(() => void this.sync())
  }

  /** The bots that need reading now: waiting for their code, or taking cards from a connected chat. */
  private async due(): Promise<Set<string>> {
    if (!(await this.allowed())) return new Set()
    const rows = await this.app.db
      .select({ id: webhooks.id, bot: telegramBots })
      .from(telegramBots)
      .innerJoin(webhooks, eq(webhooks.id, telegramBots.webhookId))
      .where(eq(webhooks.active, true))
    return new Set(
      rows.filter((r) => r.bot.problem !== TOKEN_GONE && (this.waiting(r.id) || (r.bot.takesCards && r.bot.chatId !== null))).map((r) => r.id),
    )
  }

  private async sync() {
    try {
      const due = await this.due()
      for (const [id, reader] of this.readers)
        if (!due.has(id)) {
          reader.abort()
          this.readers.delete(id)
        }
      for (const id of due)
        if (!this.readers.has(id)) {
          const reader = new AbortController()
          this.readers.set(id, reader)
          void this.read(id, reader.signal)
        }
      await this.app.db.delete(telegramCards).where(lt(telegramCards.createdAt, new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000)))
    } catch (e) {
      this.log?.error({ err: e instanceof Error ? e.message : e }, 'telegram bots')
    }
  }

  /** One bot's reader: asks, handles what came, asks again, for as long as the bot needs reading. */
  private async read(webhookId: string, signal: AbortSignal) {
    const problem = (text: string | null) => this.app.db.update(telegramBots).set({ problem: text }).where(eq(telegramBots.webhookId, webhookId))
    let fails = 0
    while (!signal.aborted) {
      try {
        await this.poll(webhookId, 50, signal)
        fails = 0
      } catch (e) {
        if (signal.aborted) return
        const status = e instanceof TelegramError ? e.status : -1
        if (status === 401 || status === 404) {
          await problem(TOKEN_GONE)
          this.readers.delete(webhookId)
          return
        }
        if (status === 409) await problem(READ_ELSEWHERE)
        else if (status === -1) this.log?.error({ err: e instanceof Error ? e.message : e }, 'telegram bot')
        const seconds = status === 409 ? 30 : status === 429 ? ((e as TelegramError).retryAfter ?? 5) : BACKOFF[Math.min(fails++, BACKOFF.length - 1)]
        await wait(seconds * 1000, signal)
      }
    }
  }

  private async load(webhookId: string): Promise<Ctx | null> {
    const [row] = await this.app.db
      .select({ hook: webhooks, bot: telegramBots, board: boards })
      .from(telegramBots)
      .innerJoin(webhooks, eq(webhooks.id, telegramBots.webhookId))
      .innerJoin(boards, eq(boards.id, webhooks.boardId))
      .where(eq(telegramBots.webhookId, webhookId))
    return row ? { app: this.app, api: this.api, token: decrypt(row.hook.secretEncrypted), site: this.site(), ...row } : null
  }

  /**
   * Asks Telegram once for what's new for a bot (waiting up to `seconds` for something to come) and handles it.
   * Returns how many things came.
   */
  async poll(webhookId: string, seconds = 0, signal?: AbortSignal): Promise<number> {
    const c = await this.load(webhookId)
    if (!c || !(await this.allowed())) return 0
    if (!this.ready.has(c.token)) {
      // (A bot set up to have its messages sent somewhere can't also be asked for them.)
      await this.api.call(c.token, 'deleteWebhook', { drop_pending_updates: false })
      await this.setMenu(c)
      this.ready.add(c.token)
    }
    const updates = await this.api.call<TgUpdate[]>(
      c.token,
      'getUpdates',
      {
        ...(c.bot.readFrom !== null && { offset: c.bot.readFrom }),
        timeout: seconds,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
      },
      (seconds + 15) * 1000,
      signal,
    )
    if (c.bot.problem && c.bot.problem !== REMOVED)
      await this.app.db.update(telegramBots).set({ problem: null }).where(eq(telegramBots.webhookId, webhookId))
    for (const u of updates) {
      try {
        const now = await this.load(webhookId)
        if (now) await this.handle(now, u)
      } catch (e) {
        // (One message that trips over something is skipped, not asked for again for ever.)
        this.log?.error({ err: e instanceof Error ? e.message : e }, 'telegram message')
      }
      await this.app.db
        .update(telegramBots)
        .set({ readFrom: u.update_id + 1 })
        .where(eq(telegramBots.webhookId, webhookId))
    }
    return updates.length
  }

  private async handle(c: Ctx, u: TgUpdate) {
    const set = (values: Partial<typeof telegramBots.$inferInsert>) =>
      this.app.db.update(telegramBots).set(values).where(eq(telegramBots.webhookId, c.hook.id))
    if (u.my_chat_member) {
      if (u.my_chat_member.chat.id !== c.bot.chatId) return
      const gone = ['left', 'kicked'].includes(u.my_chat_member.new_chat_member.status)
      if (gone) {
        // The chat no longer has the bot: nothing more is sent there until someone looks.
        await set({ problem: REMOVED })
        await this.app.db.update(webhooks).set({ active: false }).where(eq(webhooks.id, c.hook.id))
        this.changed()
      } else if (c.bot.problem === REMOVED) await set({ problem: null })
      return
    }
    if (u.callback_query) {
      if (u.callback_query.message?.chat.id === c.bot.chatId) await onButton(c, u.callback_query)
      return
    }
    const m = u.message ?? u.edited_message
    if (!m) return
    if (u.message && (await this.connect(c, m))) return
    // Only the connected chat counts: a bot's name is public, and anyone can write to it.
    if (m.chat.id !== c.bot.chatId) return
    if (m.migrate_to_chat_id) return void (await set({ chatId: m.migrate_to_chat_id }))
    if (u.edited_message) return onEdit(c, m)
    return onMessage(c, m, u.update_id)
  }

  /** `/start <code>` with a code that's waiting for this bot: this chat becomes the board's. */
  private async connect(c: Ctx, m: TgMessage): Promise<boolean> {
    const code = /^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(m.text ?? '')?.[1]
    if (!code) return false
    const waiting = this.codes.get(hash(code))
    if (!waiting || waiting.webhookId !== c.hook.id || waiting.expires <= Date.now()) return false
    this.codes.delete(hash(code))
    const kind = m.chat.type === 'private' ? ('private' as const) : ('group' as const)
    await this.app.db
      .update(telegramBots)
      .set({ chatId: m.chat.id, chatKind: kind, chatName: nameOf(m.chat).slice(0, 200), connectedBy: m.from?.id ?? null, problem: null })
      .where(eq(telegramBots.webhookId, c.hook.id))
    // (Whatever failed before there was a chat, a test sent too early, is no longer how the bot is doing.)
    await this.app.db.update(webhooks).set({ lastError: null, lastStatus: null }).where(eq(webhooks.id, c.hook.id))
    const where = c.board.inboxOf ? 'your Inbox' : `<b>${h(c.board.name)}</b>`
    const cards = c.bot.takesCards ? `\n\n${h(helpText(kind))}` : ''
    await this.api.call(c.token, 'sendMessage', { chat_id: m.chat.id, ...telegramText(`Kanbanto will post news from ${where} here.${cards}`) })
    const now = await this.load(c.hook.id)
    if (now) await this.setMenu(now).catch(() => {})
    this.changed()
    return true
  }

  /**
   * The bot's menu in its chat (the list Telegram shows for "/", and behind the Menu button): the shortcuts that work
   * there, which differ between someone's own chat and a group. Anywhere else, the bot has none.
   */
  async setMenu(c: Ctx) {
    await this.api.call(c.token, 'setMyCommands', { commands: [] })
    if (c.bot.chatId === null || !c.bot.chatKind) return
    await this.api.call(c.token, 'setMyCommands', {
      commands: c.bot.takesCards ? menuFor(c.bot.chatKind) : [],
      scope: { type: 'chat', chat_id: c.bot.chatId },
    })
  }

  /** The menu again, after what it depends on changed (whether the chat's messages become cards). */
  async refreshMenu(webhookId: string) {
    const c = await this.load(webhookId)
    if (c) await this.setMenu(c).catch(() => {})
  }
}
