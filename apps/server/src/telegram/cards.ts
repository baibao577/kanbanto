import { newId } from '@kanbanto/model/ids'
import { fireTime } from '@kanbanto/model/reminders'
import { titleDate } from '@kanbanto/model/when'
import { dayIn } from '@kanbanto/model/dates'
import { indexFor } from '@kanbanto/model/indexer'
import { byHand } from '@kanbanto/model/view'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { sessionUser, type SessionUser } from '../auth/sessions'
import { requireAccess, type BoardRow } from '../boards/access'
import { taskUrl } from '../calendar/items'
import { telegramHtml as h, telegramLink, telegramOpen, telegramText } from '../chat/format'
import { telegramBots, telegramCards, users, webhooks, type TelegramWrote } from '../db/schema'
import { HttpError } from '../http'
import { dueInWords } from '../reminders'
import { boardsFor } from '../routes/boards'
import { mentionsIn, postComment } from '../routes/comments'
import { saveUpload } from '../routes/files'
import { attachFile } from '../routes/uploads'
import { storageSettings } from '../storage/service'
import { nameOf, TelegramError, type TelegramApi, type TgMessage, type TgUpdate, type TgUser } from './api'
import { helpText } from './help'

/**
 * What's sent in a board's Telegram chat, as cards on that board. In someone's own chat with the bot every message
 * is a card; in a group, `/card …` is (Telegram shows a bot nothing else there). The bot answers with what it
 * understood, and for a while the card can be put right from the chat: "Undo" and "No date" under the answer, an
 * edit of the message, a reply to the answer (a comment).
 *
 * A card is added in the name of the person who connected the bot, who is checked again each time to be able to
 * edit the board; when someone else wrote it, the card says who. Someone who connected their own chat to a bot of
 * theirs is known by it (that chat is their Telegram account), so what they write in a group goes in their own name.
 */

type Hook = typeof webhooks.$inferSelect
type Bot = typeof telegramBots.$inferSelect
type Row = typeof telegramCards.$inferSelect
export interface Ctx {
  app: FastifyInstance
  api: TelegramApi
  token: string
  hook: Hook
  bot: Bot
  board: BoardRow
  /** The site's address, for links to cards (null while it isn't known). */
  site: string | null
}

const MB = 1024 * 1024
/** Telegram lets a bot fetch files up to this size. */
const TELEGRAM_MAX_MB = 20
const DAY = 24 * 60 * 60 * 1000
/** How long Undo, No date and an edit of the message still act on the card. (A reply is a comment for as long as the row is kept: a week.) */
export const FIX_MS = DAY
export const KEEP_DAYS = 7
/** Messages a chat can turn into cards: so many a minute, and a day. */
const PER_MINUTE = 20
const PER_DAY = 200
/** Photos sent together arrive one by one, moments apart: the ones after the first join its card. */
const ALBUM_MS = 60_000

const sent = new Map<number, number[]>()
const albums = new Map<string, { rowId: string; at: number }>()
/** (Tests start from nothing.) */
export const forgetChats = () => {
  sent.clear()
  albums.clear()
}

function allow(chatId: number): boolean {
  const now = Date.now()
  const times = (sent.get(chatId) ?? []).filter((t) => t > now - DAY)
  if (times.length >= PER_DAY || times.filter((t) => t > now - 60_000).length >= PER_MINUTE) return false
  sent.set(chatId, [...times, now])
  return true
}

// ── Talking back ────────────────────────────────────────────────────────────────

const say = (c: Ctx, chatId: number, html: string, extra: object = {}) =>
  c.api.call<{ message_id: number }>(c.token, 'sendMessage', { chat_id: chatId, ...telegramText(html), ...extra })
const replyTo = (c: Ctx, m: TgMessage, html: string, extra: object = {}) =>
  say(c, m.chat.id, html, { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true }, ...extra })

const NOTHING = 'I can take words, photos and files.'
const LATER = 'That’s a lot at once. Try again in a minute.'

type Wrote = TelegramWrote

/** The bot's answer to a card it made: what it understood, and the way to it. */
function answer(c: Ctx, taskId: string, w: Wrote): string {
  const where = c.board.inboxOf ? 'your Inbox' : `<b>${h(c.board.name)}</b>`
  const url = c.site ? taskUrl(c.site, c.board.id, taskId) : null
  return [
    `Added to ${where}${w.by ? ` by ${h(w.by)}` : ''}${w.files ? `, with ${w.files} ${w.files === 1 ? 'file' : 'files'}` : ''}`,
    h(w.title),
    w.due && `Due ${h(dueInWords(w.due, w.zone))}`,
    ...w.notes.map(h),
    w.refused && `A file wasn’t attached: ${h(w.refused)}`,
    telegramOpen(url),
  ]
    .filter(Boolean)
    .join('\n')
}
const buttons = (w: Wrote) => ({
  reply_markup: { inline_keyboard: [[{ text: 'Undo', callback_data: 'undo' }, ...(w.due ? [{ text: 'No date', callback_data: 'nodate' }] : [])]] },
})

// ── Who is writing ──────────────────────────────────────────────────────────────

const person = async (app: FastifyInstance, userId: string | null): Promise<SessionUser | null> => {
  if (!userId) return null
  const [row] = await app.db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
  return row ? sessionUser(row) : null
}
const mayEdit = (app: FastifyInstance, me: SessionUser, boardId: string) =>
  requireAccess(app.db, me, boardId, 'editor').then(
    () => true,
    () => false,
  )

/**
 * The person this Telegram account is, when they've said so: by connecting their own chat to a bot they added (someone's
 * own chat with a bot is their Telegram account).
 */
async function knownBy(app: FastifyInstance, telegramId: number): Promise<SessionUser | null> {
  const [row] = await app.db
    .select({ userId: webhooks.createdBy })
    .from(telegramBots)
    .innerJoin(webhooks, eq(webhooks.id, telegramBots.webhookId))
    .where(and(eq(telegramBots.chatKind, 'private'), eq(telegramBots.chatId, telegramId), eq(telegramBots.connectedBy, telegramId)))
  return person(app, row?.userId ?? null)
}

/**
 * Whose name something from the chat goes in: the writer's own when they're known and can edit the board, else the
 * person who connected the bot (`other`: who really wrote it, to say so). Null: nobody who may edit the board.
 */
async function whoFor(c: Ctx, from: TgUser | undefined): Promise<{ me: SessionUser; other: string | null } | null> {
  const owner = await person(c.app, c.hook.createdBy)
  const ownerOk = !!owner && (await mayEdit(c.app, owner, c.board.id))
  const theirs = c.bot.chatKind === 'private' || !from || from.id === c.bot.connectedBy
  if (theirs) return ownerOk ? { me: owner, other: null } : null
  const known = await knownBy(c.app, from.id)
  if (known && (await mayEdit(c.app, known, c.board.id))) return { me: known, other: null }
  return ownerOk ? { me: owner, other: nameOf(from) } : null
}
const NOBODY = 'Cards can’t be added here right now: the person who connected this bot can no longer edit the board.'

// ── What a message holds ────────────────────────────────────────────────────────

interface Sent {
  id: string
  size?: number
  name: string
  /** What to call a card that has only this: "Photo, 6 Oct 14:02", or the file's own name. */
  label: string
}
function fileOf(m: TgMessage, zone: string): Sent | null {
  const when = new Date(m.date * 1000)
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(when).replace(/[ :]/g, '-')
  const words = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(when)
    .replace(',', '')
  const made = (kind: string, ending: string, f: { file_id: string; file_size?: number; file_name?: string }): Sent => ({
    id: f.file_id,
    size: f.file_size,
    name: f.file_name || `${kind.toLowerCase().replace(/ /g, '-')}-${stamp}.${ending}`,
    label: f.file_name || `${kind}, ${words}`,
  })
  const photo = m.photo?.length ? [...m.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0] : null
  if (photo) return made('Photo', 'jpg', photo)
  if (m.document) return made('File', 'bin', m.document)
  if (m.video) return made('Video', 'mp4', m.video)
  if (m.audio) return made('Audio', 'mp3', m.audio)
  if (m.voice) return made('Voice message', 'ogg', m.voice)
  if (m.video_note) return made('Video', 'mp4', m.video_note)
  return null
}

/** Fetches a file from Telegram and puts it on the card. Returns why not, when it couldn't. */
async function attach(c: Ctx, me: SessionUser, taskId: string, file: Sent): Promise<string | null> {
  const { maxFileMb } = await storageSettings(c.app.db)
  const max = Math.min(TELEGRAM_MAX_MB, maxFileMb)
  if (file.size && file.size > max * MB) return `it is bigger than ${max} MB.`
  try {
    const { file_path: path } = await c.api.call<{ file_path: string }>(c.token, 'getFile', { file_id: file.id })
    const bytes = await c.api.download(c.token, path, max * MB)
    await saveUpload(c.app, { boardId: c.board.id, taskId, me, bytes, name: file.name, via: 'Telegram' })
    return null
  } catch (e) {
    if (e instanceof HttpError) return e.status === 413 ? `it is bigger than ${max} MB.` : e.message
    if (e instanceof TelegramError) return 'Telegram didn’t hand it over.'
    throw e
  }
}

/** A card's title, date and description from what was typed. Null: nothing to call it. */
function compose(text: string, o: { zone: string; readDate: boolean; notes: string[]; label?: string }) {
  const [first = '', ...more] = text.split('\n')
  let rest = more.join('\n').trim()
  const typed = first.trim() || o.label || ''
  if (!typed) return null
  let title = typed
  let due: string | null = null
  const found = o.readDate && first.trim() ? titleDate(title, new Date(), o.zone) : null
  if (found) {
    title = found.title
    due = found.due
  }
  // A long first line is the whole thought: the card's name is how it starts, and all of it is in the description.
  if (title.length > 200) {
    rest = [title, rest].filter(Boolean).join('\n\n')
    title = `${title.slice(0, 119).trimEnd()}…`
  }
  const description = [o.notes.join('\n'), rest].filter(Boolean).join('\n\n').slice(0, 20_000)
  return { title, typed, due, description }
}

const COMMAND = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/

// ── The menu: shortcuts that answer in the chat ────────────────────────────────

/**
 * The shortcuts a chat's menu offers (what Telegram lists for "/"). `/list` and `/today` show card titles in the
 * chat: whoever connected the bot chose that chat for the board, and everyone in it can read them.
 */
export const menuFor = (kind: 'private' | 'group') => [
  ...(kind === 'group' ? [{ command: 'card', description: 'Add a card' }] : []),
  { command: 'list', description: 'The cards waiting in the list' },
  ...(kind === 'private' ? [{ command: 'today', description: 'What is due, and your reminders' }] : []),
  { command: 'board', description: 'Open the board' },
  { command: 'help', description: 'How this works' },
]
/** Cards a shortcut lists before "and 8 more". */
const SHOWN = 15

/** The person a shortcut reads as: whoever connected the bot, while they can still open the board. */
async function reader(c: Ctx): Promise<SessionUser | null> {
  const me = await person(c.app, c.hook.createdBy)
  if (!me) return null
  return requireAccess(c.app.db, me, c.board.id, 'viewer').then(
    () => me,
    () => null,
  )
}
const NOT_NOW = 'That can’t be shown here right now: the person who connected this bot can no longer open the board.'
const boardUrl = (c: Ctx) => (c.site ? `${c.site}/#/b/${encodeURIComponent(c.board.id)}` : null)
const placeOf = (c: Ctx) => (c.board.inboxOf ? 'your Inbox' : `<b>${h(c.board.name)}</b>`)

/** `/board`: the way to the board. (It opens for people who can sign in and open it.) */
async function showBoard(c: Ctx): Promise<string> {
  const url = boardUrl(c)
  if (!url) return 'I don’t know this site’s address yet. Open Kanbanto in a browser once, and ask again.'
  return `${c.board.inboxOf ? 'Your Inbox' : `<b>${h(c.board.name)}</b>`} in Kanbanto: ${telegramOpen(url)}`
}

/** `/list`: the cards waiting in the list new cards go to, in the order they're in on the board. */
async function showList(c: Ctx): Promise<string> {
  const me = await reader(c)
  if (!me) return NOT_NOW
  const { data } = await c.app.engine.snapshot(c.board.id)
  const idx = indexFor(data)
  const list = (c.bot.cardsTo ? idx.colById.get(c.bot.cardsTo) : undefined) ?? idx.colById.get(idx.firstOf.todo)
  if (!list) return 'This board has no list to show.'
  // The cards the board shows in that list: each task where statuses are set by hand, and where a task's status
  // follows its subtasks, the pieces of work themselves (the tasks that have none).
  const cards = idx.mode === 'manual' ? idx.roots : idx.preorder.filter((id) => !idx.childrenOf.has(id))
  const ids = byHand(
    idx,
    cards.filter((id) => idx.status.get(id) === list.id),
  )
  if (!ids.length) return `Nothing is waiting in <b>${h(list.name)}</b> ${c.board.inboxOf ? 'in' : 'on'} ${placeOf(c)}.`
  const zone = me.timeZone ?? 'UTC'
  const lines = ids.slice(0, SHOWN).map((id) => {
    const t = data.tasks[id]
    return `• ${telegramLink(c.site ? taskUrl(c.site, c.board.id, id) : null, t.title)}${t.due ? ` · due ${h(dueInWords(t.due, zone))}` : ''}`
  })
  return [
    `<b>${h(list.name)}</b> ${c.board.inboxOf ? 'in' : 'on'} ${placeOf(c)}: ${ids.length} ${ids.length === 1 ? 'card' : 'cards'}`,
    ...lines,
    ids.length > SHOWN && `and ${ids.length - SHOWN} more`,
    telegramOpen(boardUrl(c), 'Open the board ›'),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * `/today`, in someone's own chat with a bot they connected: what is theirs and coming up, on every board they can
 * open. Overdue, due today and due tomorrow (a whole-day date has no hour to count 24 hours from, so it goes by the
 * day), and the reminders going off in the next 24 hours. "Theirs" is what their calendar shows: cards assigned to
 * them, and cards nobody is assigned on boards where they are the only person (their Inbox, for one).
 */
async function showToday(c: Ctx): Promise<string> {
  if (c.bot.chatKind !== 'private') return 'That works in your own chat with a bot.'
  const me = await person(c.app, c.hook.createdBy)
  if (!me) return NOT_NOW
  const zone = me.timeZone ?? 'UTC'
  const now = new Date()
  const today = dayIn(now, zone)
  const tomorrow = dayIn(new Date(now.getTime() + DAY), zone)
  const open = (await boardsFor(c.app.db, me.id)).filter((b) => !b.archivedAt)
  const boardsData = await c.app.engine.snapshots(open.map((b) => b.id))
  type Item = { boardId: string; id: string; title: string; board: string; when: string; at: number }
  const overdue: Item[] = []
  const dueToday: Item[] = []
  const dueTomorrow: Item[] = []
  const reminders: Item[] = []
  for (const [boardId, data] of boardsData) {
    const idx = indexFor(data)
    const alone = data.members.length === 1 && data.members[0].id === me.id
    for (const t of Object.values(data.tasks)) {
      if (idx.category.get(t.id) === 'done') continue
      const item = (when: string, at: number): Item => ({ boardId, id: t.id, title: t.title, board: data.board.name, when, at })
      if (t.due && (t.assigneeId ? t.assigneeId === me.id : alone)) {
        const timed = t.due.length > 10
        const day = timed ? dayIn(new Date(t.due), zone) : t.due
        const at = timed ? Date.parse(t.due) : Date.parse(`${t.due}T00:00:00Z`)
        // (Today and tomorrow: the time when it has one, else nothing more to say. Overdue: the day it was due.)
        const time = timed ? dueInWords(t.due, zone).split(', ')[1] : ''
        if (day < today) overdue.push(item(`was due ${dueInWords(t.due, zone)}`, at))
        else if (day === today) dueToday.push(item(time, at))
        else if (day === tomorrow) dueTomorrow.push(item(time, at))
      }
      for (const r of t.reminders ?? []) {
        if ((t.assigneeId ?? r.by) !== me.id) continue
        const at = fireTime(r, t)
        if (at && at > now && at.getTime() <= now.getTime() + DAY) reminders.push(item(dueInWords(at.toISOString(), zone), at.getTime()))
      }
    }
  }
  const line = (t: Item) =>
    `• ${telegramLink(c.site ? taskUrl(c.site, t.boardId, t.id) : null, t.title)} · ${h(t.board)}${t.when ? ` · ${h(t.when)}` : ''}`
  const part = (title: string, items: Item[]) => {
    const sorted = items.sort((a, b) => a.at - b.at)
    return sorted.length
      ? [`<b>${title}</b>`, ...sorted.slice(0, SHOWN).map(line), ...(sorted.length > SHOWN ? [`and ${sorted.length - SHOWN} more`] : [])]
      : []
  }
  const all = [
    ...part('Overdue', overdue),
    ...part('Due today', dueToday),
    ...part('Due tomorrow', dueTomorrow),
    ...part('Reminders in the next 24 hours', reminders),
  ]
  return all.length ? all.join('\n') : 'Nothing is due today or tomorrow, nothing is overdue, and no reminder is set for the next 24 hours.'
}

// ── A message ──────────────────────────────────────────────────────────────────

export async function onMessage(c: Ctx, m: TgMessage, updateId: number) {
  const group = c.bot.chatKind === 'group'
  const raw = (m.text ?? m.caption ?? '').trim()
  const cmd = COMMAND.exec(raw)
  // (A command for another bot in the same group is none of this one's business.)
  if (cmd?.[2] && cmd[2].toLowerCase() !== c.bot.botName.toLowerCase()) return
  const command = cmd?.[1].toLowerCase()
  if (command === 'help' || command === 'start') return void (await replyTo(c, m, helpText(group ? 'group' : 'private')))
  if (command === 'board' || command === 'list' || command === 'today') {
    if (!allow(m.chat.id)) return void (await replyTo(c, m, LATER))
    return void (await replyTo(c, m, await (command === 'board' ? showBoard(c) : command === 'list' ? showList(c) : showToday(c))))
  }

  // A reply to one of the bot's own answers: a comment on that card.
  const about = m.reply_to_message
  if (about?.from?.is_bot && command !== 'card') {
    const [row] = await c.app.db
      .select()
      .from(telegramCards)
      .where(and(eq(telegramCards.webhookId, c.hook.id), eq(telegramCards.answerId, about.message_id)))
    if (row) return comment(c, m, row, raw)
    if (group) return
  }
  // (In a group only commands reach a bot; with that switched off at @BotFather, the rest is still not for it.)
  if (group && command !== 'card') return
  if (!c.bot.takesCards) return void (await replyTo(c, m, 'This bot only posts the board’s news. Cards are added in Kanbanto.'))
  if (command && command !== 'card') return void (await replyTo(c, m, helpText('private')))
  if (!allow(m.chat.id)) return void (await replyTo(c, m, LATER))

  const who = await whoFor(c, m.from)
  if (!who) return void (await replyTo(c, m, NOBODY))
  const { me } = who
  const zone = me.timeZone ?? 'UTC'
  let text = command === 'card' ? (cmd![3] ?? '').trim() : raw
  let file = fileOf(m, zone)
  const notes: string[] = []
  let own = true
  // `/card` in reply to a message: a card of that message (under words of the sender's own, if they added any).
  const source = command === 'card' && about && !about.from?.is_bot ? about : null
  if (source) {
    const theirs = (source.text ?? source.caption ?? '').trim()
    if (source.from && source.from.id !== m.from?.id) notes.push(`From ${nameOf(source.from)}`)
    own = !!text
    text = text ? `${text}\n${theirs}` : theirs
    file ??= fileOf(source, zone)
  } else if (who.other) notes.push(`From ${who.other}`)
  if (m.forward_origin) {
    const o = m.forward_origin
    notes.push(`Forwarded from ${o.sender_user ? nameOf(o.sender_user) : (o.sender_user_name ?? nameOf(o.sender_chat ?? o.chat))}`)
    own = false
  }

  // Photos sent together: the ones after the first go on its card.
  const albumKey = m.media_group_id ? `${c.hook.id}:${m.media_group_id}` : null
  const album = albumKey ? albums.get(albumKey) : null
  if (album && album.at > Date.now() - ALBUM_MS && file) {
    const [row] = await c.app.db.select().from(telegramCards).where(eq(telegramCards.id, album.rowId))
    if (row) {
      const refused = await attach(c, me, row.taskId, file)
      const wrote = { ...row.wrote, ...(refused ? { refused } : { files: row.wrote.files + 1 }) }
      await c.app.db.update(telegramCards).set({ wrote }).where(eq(telegramCards.id, row.id))
      if (row.answerId) await rewrite(c, row, wrote)
      return
    }
  }

  const said = compose(text, { zone, readDate: own, notes, label: file?.label })
  if (!said) return void (await replyTo(c, m, command === 'card' ? 'Say what the card is: /card Fix the sign-up page' : NOTHING))
  const { data } = await c.app.engine.snapshot(c.board.id)
  const status = c.bot.cardsTo && data.columns.some((col) => col.id === c.bot.cardsTo) ? c.bot.cardsTo : undefined
  const taskId = newId()
  // (The update's own id: if this is tried twice, the second time adds nothing. And the bot's webhook, so its own
  // chat isn't sent the news of it: the bot answers there itself.)
  await c.app.engine.mutate(
    c.board.id,
    `tg:${c.hook.id}:${updateId}`,
    {
      type: 'task.create',
      id: taskId,
      parentId: null,
      fields: {
        title: said.title,
        ...(said.description && { description: said.description }),
        ...(said.due && { due: said.due }),
        ...(status && { status }),
      },
    },
    me.id,
    'Telegram',
  )
  // The card is there whatever happens to its file.
  const refused = file ? await attach(c, me, taskId, file) : null
  const wrote = await asSaved(c, c.board.id, taskId, {
    ...said,
    own,
    notes,
    files: file && !refused ? 1 : 0,
    ...(refused && { refused }),
    ...(group && { by: me.name }),
    zone,
  })
  const rowId = newId()
  const reply = await replyTo(c, m, answer(c, taskId, wrote), buttons(wrote)).catch(() => null)
  await c.app.db.insert(telegramCards).values({
    id: rowId,
    webhookId: c.hook.id,
    chatId: m.chat.id,
    messageId: m.message_id,
    answerId: reply?.message_id ?? null,
    boardId: c.board.id,
    taskId,
    writerId: m.from?.id ?? m.chat.id,
    userId: me.id,
    wrote,
  })
  if (albumKey) albums.set(albumKey, { rowId, at: Date.now() })
}

/** `wrote`, with the card's title, description and date as they were really saved (the board tidies what it's given). */
async function asSaved(c: Ctx, boardId: string, taskId: string, wrote: Wrote): Promise<Wrote> {
  const task = (await c.app.engine.snapshot(boardId)).data.tasks[taskId]
  return task ? { ...wrote, title: task.title, description: task.description ?? '', due: task.due ?? null } : wrote
}

/** Writes the bot's answer again, after the card it's about changed. */
const rewrite = (c: Ctx, row: Row, wrote: Wrote) =>
  c.api
    .call(c.token, 'editMessageText', {
      chat_id: row.chatId,
      message_id: row.answerId,
      ...telegramText(answer(c, row.taskId, wrote)),
      ...buttons(wrote),
    })
    .catch(() => {})

// ── A reply to the bot's answer: a comment ──────────────────────────────────────

async function comment(c: Ctx, m: TgMessage, row: Row, words: string) {
  if (!allow(m.chat.id)) return void (await replyTo(c, m, LATER))
  const who = await whoFor(c, m.from)
  if (!who) return void (await replyTo(c, m, NOBODY))
  const { me } = who
  const file = fileOf(m, me.timeZone ?? 'UTC')
  if (!words && !file) return void (await replyTo(c, m, NOTHING))
  const body = (who.other ? `From ${who.other}: ${words}` : words).slice(0, 10_000)
  try {
    const { board } = await requireAccess(c.app.db, me, row.boardId, 'viewer', { write: true })
    const { data } = await c.app.engine.snapshot(row.boardId)
    if (!data.tasks[row.taskId]) throw new HttpError(404, 'That card is no longer on the board.')
    let note = ''
    if (file) {
      const { maxFileMb } = await storageSettings(c.app.db)
      const max = Math.min(TELEGRAM_MAX_MB, maxFileMb)
      if (file.size && file.size > max * MB) throw new HttpError(413, `That file is bigger than ${max} MB.`)
      const { file_path: path } = await c.api.call<{ file_path: string }>(c.token, 'getFile', { file_id: file.id })
      const bytes = await c.api.download(c.token, path, max * MB)
      await attachFile(c.app, {
        boardId: row.boardId,
        taskId: row.taskId,
        me,
        bytes,
        name: file.name,
        comment: body || 'Sent from Telegram.',
        via: 'Telegram',
        notToHook: c.hook.id,
      })
      note = ', with the file'
    } else await postComment(c.app, board, me, row.taskId, { body, mentions: mentionsIn(data.members, body), notToHook: c.hook.id })
    await replyTo(c, m, `Added as a comment on ${h(`“${data.tasks[row.taskId].title}”`)}${note}.`)
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof TelegramError)) throw e
    await replyTo(c, m, `That wasn’t added: ${h(e instanceof HttpError ? e.message : 'Telegram didn’t hand the file over.')}`)
  }
}

// ── An edited message: the card follows ─────────────────────────────────────────

export async function onEdit(c: Ctx, m: TgMessage) {
  const [row] = await c.app.db
    .select()
    .from(telegramCards)
    .where(and(eq(telegramCards.webhookId, c.hook.id), eq(telegramCards.messageId, m.message_id)))
  const was = row?.wrote
  if (!row || !was || row.undone || !was.own || row.createdAt.getTime() < Date.now() - FIX_MS) return
  const me = await person(c.app, row.userId)
  if (!me || !(await mayEdit(c.app, me, row.boardId))) return
  const { data } = await c.app.engine.snapshot(row.boardId)
  const task = data.tasks[row.taskId]
  if (!task) return
  const url = c.site ? taskUrl(c.site, row.boardId, row.taskId) : null
  if (task.title !== was.title || (task.description ?? '') !== was.description || (task.due ?? null) !== was.due)
    return void (await replyTo(
      c,
      m,
      ['This card was changed in Kanbanto since, so I left it as it is.', telegramOpen(url)].filter(Boolean).join(' '),
    ))
  const raw = (m.text ?? m.caption ?? '').trim()
  const cmd = COMMAND.exec(raw)
  const text = cmd?.[1].toLowerCase() === 'card' ? (cmd[3] ?? '').trim() : raw
  const said = compose(text, { zone: was.zone, readDate: true, notes: was.notes, label: was.title })
  if (!said) return
  await c.app.engine.mutate(
    row.boardId,
    `tg:${c.hook.id}:edit:${newId()}`,
    // (An empty date is how a card's date is taken off.)
    { type: 'task.update', id: row.taskId, fields: { title: said.title, description: said.description, due: said.due ?? '' } },
    me.id,
    'Telegram',
  )
  const wrote = await asSaved(c, row.boardId, row.taskId, { ...was, ...said })
  await c.app.db.update(telegramCards).set({ wrote }).where(eq(telegramCards.id, row.id))
  if (row.answerId) await rewrite(c, row, wrote)
}

// ── The buttons under the answer ───────────────────────────────────────────────

export async function onButton(c: Ctx, q: NonNullable<TgUpdate['callback_query']>) {
  const done = (text?: string) => c.api.call(c.token, 'answerCallbackQuery', { callback_query_id: q.id, ...(text && { text }) }).catch(() => {})
  const [row] = q.message
    ? await c.app.db
        .select()
        .from(telegramCards)
        .where(and(eq(telegramCards.webhookId, c.hook.id), eq(telegramCards.answerId, q.message.message_id)))
    : []
  const was = row?.wrote
  if (!row || !was || row.undone || row.createdAt.getTime() < Date.now() - FIX_MS) return done('That was a while ago. Change the card in Kanbanto.')
  if (c.bot.chatKind === 'group' && q.from.id !== row.writerId) return done('Only the person who added it can do that.')
  const me = await person(c.app, row.userId)
  if (!me || !(await mayEdit(c.app, me, row.boardId))) return done('That can’t be changed from here any more.')
  const { data } = await c.app.engine.snapshot(row.boardId)
  if (!data.tasks[row.taskId]) return done('That card is no longer on the board.')
  const change = (command: Parameters<FastifyInstance['engine']['mutate']>[2]) =>
    c.app.engine.mutate(row.boardId, `tg:${c.hook.id}:fix:${newId()}`, command, me.id, 'Telegram')

  if (q.data === 'undo') {
    await change({ type: 'task.archive', id: row.taskId })
    await c.app.db.update(telegramCards).set({ undone: true }).where(eq(telegramCards.id, row.id))
    const where = c.board.inboxOf ? 'your Inbox’s archive' : `the archive of ${h(c.board.name)}`
    await c.api
      .call(c.token, 'editMessageText', {
        chat_id: row.chatId,
        message_id: row.answerId,
        ...telegramText(`Taken back: ${h(`“${data.tasks[row.taskId].title}”`)}. It’s in ${where} if you want it again.`),
      })
      .catch(() => {})
    return done('Taken back')
  }
  if (q.data === 'nodate' && was.due) {
    // The words that were read as a date are part of the title again.
    await change({ type: 'task.update', id: row.taskId, fields: { title: was.typed.slice(0, 500), due: '' } })
    const wrote = await asSaved(c, row.boardId, row.taskId, { ...was, title: was.typed.slice(0, 500), due: null })
    await c.app.db.update(telegramCards).set({ wrote }).where(eq(telegramCards.id, row.id))
    await rewrite(c, row, wrote)
    return done('No date')
  }
  return done()
}
