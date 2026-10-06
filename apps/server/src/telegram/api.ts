import { fetch } from 'undici'
import { env } from '../env'
import { HttpError } from '../http'
import { fetchFile } from '../storage/download'

/**
 * Telegram's bot API, as much of it as a board's bot needs: asking for new messages, sending, and fetching a file
 * someone sent. A bot's token is part of every address here, so nothing in this file puts an address in an error or
 * a log line.
 */

/** Telegram refused (or couldn't be reached: status 0). */
export class TelegramError extends Error {
  readonly status: number
  /** Seconds Telegram asks to wait (too many requests). */
  readonly retryAfter?: number
  /** The chat became a supergroup with this id: use it from now on. */
  readonly migrateTo?: number
  constructor(status: number, message: string, more: { retryAfter?: number; migrateTo?: number } = {}) {
    super(message)
    this.status = status
    this.retryAfter = more.retryAfter
    this.migrateTo = more.migrateTo
  }
}

export interface TelegramApi {
  /** Calls a method of the bot API (`getMe`, `sendMessage`…) and returns its result. `waitMs`: how long to wait for the answer. */
  call<T = unknown>(token: string, method: string, params?: object, waitMs?: number, signal?: AbortSignal): Promise<T>
  /** The bytes of a file someone sent the bot (`path` from `getFile`), up to `maxBytes`. */
  download(token: string, path: string, maxBytes: number): Promise<Buffer>
}

/** Telegram itself (or, with another `base`, a stand-in for it). */
export function telegramApi(base: string = env.telegramApiUrl): TelegramApi {
  const standIn = base !== 'https://api.telegram.org'
  return {
    async call<T>(token: string, method: string, params: object = {}, waitMs = 15_000, signal?: AbortSignal) {
      let res: Awaited<ReturnType<typeof fetch>>
      try {
        res = await fetch(`${base}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(waitMs)]) : AbortSignal.timeout(waitMs),
        })
      } catch {
        throw new TelegramError(0, 'Telegram couldn’t be reached.')
      }
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean
        result?: T
        description?: string
        error_code?: number
        parameters?: { retry_after?: number; migrate_to_chat_id?: number }
      } | null
      if (!body?.ok)
        throw new TelegramError(body?.error_code ?? res.status, body?.description ?? `Telegram answered ${res.status}.`, {
          retryAfter: body?.parameters?.retry_after,
          migrateTo: body?.parameters?.migrate_to_chat_id,
        })
      return body.result as T
    },
    async download(token, path, maxBytes) {
      // (fetchFile's refusals never repeat the address, which has the token in it.)
      const file = await fetchFile(`${base}/file/bot${token}/${path}`, maxBytes, standIn ? { anyAddress: true } : {}).catch((e) => {
        throw e instanceof HttpError && e.status === 413 ? e : new HttpError(502, 'Telegram didn’t hand the file over.')
      })
      return file.bytes
    },
  }
}

// ── What Telegram sends (the parts read here) ──────────────────────────────────

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}
export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  first_name?: string
  last_name?: string
  username?: string
}
interface TgFile {
  file_id: string
  file_size?: number
  file_name?: string
}
export interface TgMessage {
  message_id: number
  date: number
  from?: TgUser
  chat: TgChat
  text?: string
  caption?: string
  photo?: TgFile[]
  document?: TgFile
  video?: TgFile
  audio?: TgFile
  voice?: TgFile
  video_note?: TgFile
  animation?: TgFile
  media_group_id?: string
  reply_to_message?: TgMessage
  forward_origin?: { type: string; sender_user?: TgUser; sender_user_name?: string; sender_chat?: TgChat; chat?: TgChat }
  migrate_to_chat_id?: number
}
export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage }
  my_chat_member?: { chat: TgChat; new_chat_member: { status: string } }
}

/** What someone is called in Telegram: their name, else their @name. */
export const nameOf = (u: TgUser | TgChat | undefined) =>
  [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u && 'title' in u ? u.title : '') || (u?.username ? `@${u.username}` : '') || 'Someone'

// ── A stand-in for tests ──────────────────────────────────────────────────────

/**
 * A stand-in for Telegram that keeps everything in memory (tests). Bots are known by their tokens; `push` queues
 * what a chat sends a bot; `sent` is everything the bots were asked to do; `fail` makes the next call fail with it.
 */
export class MemoryTelegram implements TelegramApi {
  bots = new Map<string, { id: number; username: string }>()
  sent: { token: string; method: string; params: Record<string, unknown> }[] = []
  files = new Map<string, Buffer>()
  fail: TelegramError | null = null
  private waiting = new Map<string, TgUpdate[]>()
  private n = 1000

  /** A bot someone made at @BotFather, and its token. */
  bot(username: string, id = ++this.n): string {
    const token = `${id}:AAtest_${username}_${'x'.repeat(24)}`
    this.bots.set(token, { id, username })
    return token
  }

  /** Something arrives for the bot: a message, an edit, a tap on a button. Returns the update's id. */
  push(token: string, update: Omit<TgUpdate, 'update_id'>): number {
    const id = ++this.n
    this.waiting.set(token, [...(this.waiting.get(token) ?? []), { update_id: id, ...update }])
    return id
  }

  /** A file a message can carry: its id for the message. */
  file(name: string, bytes: Buffer): TgFile {
    const id = `f${++this.n}`
    this.files.set(id, bytes)
    return { file_id: id, file_size: bytes.length, file_name: name }
  }

  /** What bots sent or changed, newest last: `sendMessage`, `editMessageText`… */
  did(method: string) {
    return this.sent.filter((s) => s.method === method).map((s) => s.params)
  }

  async call<T>(token: string, method: string, params: object = {}): Promise<T> {
    if (this.fail) {
      const e = this.fail
      this.fail = null
      throw e
    }
    const bot = this.bots.get(token)
    if (!bot) throw new TelegramError(401, 'Unauthorized')
    const p = params as Record<string, unknown>
    this.sent.push({ token, method, params: p })
    switch (method) {
      case 'getMe':
        return { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username } as T
      case 'getUpdates': {
        const from = typeof p.offset === 'number' ? p.offset : 0
        const left = (this.waiting.get(token) ?? []).filter((u) => u.update_id >= from)
        this.waiting.set(token, left)
        return left as T
      }
      case 'sendMessage':
        return { message_id: ++this.n, chat: { id: p.chat_id } } as T
      case 'getFile': {
        const id = String(p.file_id)
        if (!this.files.has(id)) throw new TelegramError(400, 'Bad Request: file not found')
        return { file_id: id, file_path: id, file_size: this.files.get(id)!.length } as T
      }
      default:
        return true as T
    }
  }

  async download(_token: string, path: string, maxBytes: number) {
    const bytes = this.files.get(path)
    if (!bytes) throw new HttpError(502, 'Telegram didn’t hand the file over.')
    if (bytes.length > maxBytes)
      throw new HttpError(413, `That file is bigger than the ${Math.floor(maxBytes / (1024 * 1024))} MB that can be fetched.`)
    return bytes
  }
}
