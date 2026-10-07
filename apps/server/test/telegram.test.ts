import { readFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attachments, boardActivity, comments, tasks, telegramBots, telegramCards, webhooks } from '../src/db/schema'
import { sendReminders } from '../src/reminders'
import { chatBody } from '../src/chat/format'
import { telegramApi, type TgChat, type TgMessage, type TgUser } from '../src/telegram/api'
import { HELP } from '../src/telegram/help'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

// People in Telegram, and the chats they write in.
const ANN: TgUser = { id: 501, first_name: 'Ann' }
const BEN: TgUser = { id: 502, first_name: 'Ben', last_name: 'Ortiz' }
const own = (u: TgUser): TgChat => ({ id: u.id, type: 'private', first_name: u.first_name })
const GROUP: TgChat = { id: -9001, type: 'group', title: 'Launch team' }

/** Ann (a platform admin) with her first board, on a site that allows Telegram bots (webhooks stay off: bots don't need them). */
async function site(settings: object = { telegramBots: true }) {
  const ann = await Person.signUp(t.app, 'Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  await ann.ok('PATCH', '/api/admin/settings', settings)
  await ann.ok('PATCH', '/api/auth/me', { timeZone: 'Asia/Bangkok' })
  // (A site on the internet: Telegram makes links of its addresses.)
  t.app.mail.siteUrl = 'https://kanbanto.example'
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  return { ann, id }
}
/** A bot made at @BotFather and added to a board; `connect` sends its code from a chat. */
async function addBot(p: Person, boardId: string, name: string) {
  const token = t.telegram.bot(name)
  const r = await p.ok('POST', `/api/boards/${boardId}/webhooks`, { format: 'telegram', token })
  const hookId = r.id as string
  const poll = () => t.app.telegram.poll(hookId)
  const connect = async (chat: TgChat, from: TgUser, code: string = r.connect.code) => {
    send(token, chat, from, chat.type === 'private' ? `/start ${code}` : `/start@${name} ${code}`)
    await poll()
  }
  return { token, hookId, code: r.connect.code as string, poll, connect }
}
let n = 100
const message = (chat: TgChat, from: TgUser, text: string | undefined, more: Partial<TgMessage> = {}): TgMessage => ({
  message_id: ++n,
  date: Math.floor(Date.now() / 1000),
  chat,
  from,
  ...(text !== undefined && { text }),
  ...more,
})
/** Someone sends the bot a message. Returns the message (for replies and edits). */
const send = (token: string, chat: TgChat, from: TgUser, text?: string, more: Partial<TgMessage> = {}) => {
  const m = message(chat, from, text, more)
  t.telegram.push(token, { message: m })
  return m
}
const said = () =>
  t.telegram.did('sendMessage') as {
    chat_id: number
    text: string
    reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
  }[]
/** The cards a bot made on a board, oldest first (the board's own example cards have short ids of their own). */
const cards = async (boardId: string) =>
  (await t.db.select().from(tasks).where(eq(tasks.boardId, boardId)))
    .filter((c) => /^[0-9a-f]{8}-/.test(c.id))
    .sort((a, b) => a.id.localeCompare(b.id))
const deliver = async () => {
  await new Promise((r) => setTimeout(r, 100))
  await t.app.webhooks.queued()
  return t.app.webhooks.process()
}

describe('a board’s Telegram bot', () => {
  it('is off until a platform admin allows it; needs a real token; one bot serves one board', async () => {
    // (Webhooks being on doesn't turn bots on: each has its own switch.)
    const { ann, id } = await site({ webhooks: 'any' })
    const token = t.telegram.bot('launch_bot')
    expect(await ann.request('POST', `/api/boards/${id}/webhooks`, { format: 'telegram', token })).toMatchObject({
      status: 403,
      body: { error: expect.stringMatching(/Telegram bots are turned off/) },
    })
    await ann.ok('PATCH', '/api/admin/settings', { telegramBots: true })
    expect((await ann.request('POST', `/api/boards/${id}/webhooks`, { format: 'telegram' })).status).toBe(400)
    expect(await ann.request('POST', `/api/boards/${id}/webhooks`, { format: 'telegram', token: 'hello' })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/isn’t a bot’s token/) },
    })
    expect(await ann.request('POST', `/api/boards/${id}/webhooks`, { format: 'telegram', token: '42:AAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/doesn’t know that token/) },
    })
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks).toHaveLength(0)

    const added = await ann.ok('POST', `/api/boards/${id}/webhooks`, { format: 'telegram', token })
    expect(added.connect).toMatchObject({ privateLink: `https://t.me/launch_bot?start=${added.connect.code}`, minutes: 10 })
    expect(added.connect.groupLink).toBe(`https://t.me/launch_bot?startgroup=${added.connect.code}`)
    const list = await ann.ok('GET', `/api/boards/${id}/webhooks`)
    expect(list.telegramBots).toBe(true)
    expect(list.webhooks[0]).toMatchObject({
      url: 'https://t.me/launch_bot',
      format: 'telegram',
      telegram: { bot: 'launch_bot', chat: null, takesCards: true, cardsTo: null, problem: null },
    })
    // The token is the bot: kept encrypted, and never shown again.
    const [row] = await t.db.select().from(webhooks)
    expect(row.secretEncrypted).not.toContain('AAtest')
    expect(JSON.stringify(list)).not.toContain(token)
    expect((await ann.request('GET', `/api/boards/${id}/webhooks/${added.id}/secret`)).status).toBe(400)
    expect((await ann.request('PATCH', `/api/boards/${id}/webhooks/${added.id}`, { url: 'https://example.com/x' })).status).toBe(400)

    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Other' })
    expect(await ann.request('POST', `/api/boards/${other}/webhooks`, { format: 'telegram', token })).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/One bot serves one board/) },
    })
    // Only owners.
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    expect((await bob.request('POST', `/api/boards/${id}/webhooks/${added.id}/telegram/code`)).status).toBe(403)
  })

  it('is connected to the first chat that sends its code, which then gets the board’s news', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    // Before any chat is connected, a change has nowhere to go.
    const change = (title: string) =>
      ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.update', id: 'A', fields: { title } } })
    await change('Launch')
    expect(await deliver()).toBe(0)

    // A stranger who found the bot, and a wrong code: nothing.
    send(bot.token, own(BEN), BEN, 'hello?')
    send(bot.token, own(BEN), BEN, '/start not-the-code')
    await bot.poll()
    expect(said()).toHaveLength(0)

    // (A test sent before any chat is connected fails, and the bot looks broken until one is.)
    expect(await ann.ok('POST', `/api/boards/${id}/webhooks/${bot.hookId}/test`)).toMatchObject({
      ok: false,
      error: 'No chat is connected to this bot yet.',
    })
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].lastError).toBe('No chat is connected to this bot yet.')

    await bot.connect(own(ANN), ANN)
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].lastError).toBeNull()
    // A bot connected to your own chat is one your own reminders and mentions can come through, whatever board it's on.
    expect(await ann.ok('GET', '/api/account/telegram')).toEqual({
      allowed: true,
      bots: [{ bot: 'launch_bot', board: 'My first board', inbox: false }],
    })
    expect(said()).toHaveLength(1)
    expect(said()[0]).toMatchObject({
      chat_id: 501,
      text: expect.stringMatching(/^Kanbanto will post news from <b>My first board<\/b> here\.\n\n• Send me a message and it becomes a card/),
    })
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].telegram.chat).toEqual({ kind: 'private', name: 'Ann' })
    // The code worked once: someone else sending it changes nothing.
    await bot.connect(own(BEN), BEN)
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].telegram.chat).toEqual({ kind: 'private', name: 'Ann' })

    await change('Launch <b>@everyone</b>')
    await ann.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Looks good' })
    expect(await deliver()).toBe(2)
    const [, renamed, comment] = said()
    expect(renamed).toMatchObject({ chat_id: 501, parse_mode: 'HTML' })
    // What people typed is written out: no tag of Telegram's, and nobody mentioned.
    expect(renamed.text).toMatch(/^Ann renamed “Launch” to <a href="[^"]+\?task=A">“Launch &lt;b&gt;@⁠everyone&lt;\/b&gt;”<\/a> on My first board$/)
    expect(comment.text).toMatch(/commented on .* on My first board: Looks good$/)
    expect((await ann.ok('POST', `/api/boards/${id}/webhooks/${bot.hookId}/test`)).ok).toBe(true)

    // A code runs out, and a new one makes the one before useless; another chat can then take the bot over.
    const first = (await ann.ok('POST', `/api/boards/${id}/webhooks/${bot.hookId}/telegram/code`)).connect.code
    const second = (await ann.ok('POST', `/api/boards/${id}/webhooks/${bot.hookId}/telegram/code`)).connect.code
    await bot.connect(GROUP, ANN, first)
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].telegram.chat.kind).toBe('private')
    t.app.telegram.expireCodes()
    await bot.connect(GROUP, ANN, second)
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].telegram.chat.kind).toBe('private')
    const third = (await ann.ok('POST', `/api/boards/${id}/webhooks/${bot.hookId}/telegram/code`)).connect.code
    await bot.connect(GROUP, ANN, third)
    expect((await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks[0].telegram.chat).toEqual({ kind: 'group', name: 'Launch team' })

    // Switched off for the site: nothing is read, and nothing goes out.
    await ann.ok('PATCH', '/api/admin/settings', { telegramBots: false })
    send(bot.token, GROUP, ANN, '/card Not now')
    expect(await bot.poll()).toBe(0)
    expect(await ann.ok('POST', `/api/boards/${id}/webhooks/${bot.hookId}/test`)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/turned off/),
    })
  })
})

describe('messages in your own chat with the bot become cards', () => {
  it('the first line is the title, the rest the description, and a time in it the due date where you are', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)

    send(bot.token, own(ANN), ANN, 'Renew the domain\nkanbanto.com runs out on 14 Nov, card ending 4412')
    send(bot.token, own(ANN), ANN, 'Call Sam about the invoice tomorrow 3pm')
    // (Someone else who writes to the bot is not the connected chat.)
    send(bot.token, own(BEN), BEN, 'Add me a card')
    expect(await bot.poll()).toBe(3)

    const [renew, call] = await cards(id)
    expect(renew).toMatchObject({
      title: 'Renew the domain',
      description: 'kanbanto.com runs out on 14 Nov, card ending 4412',
      due: null,
      status: 'todo',
    })
    expect(call.title).toBe('Call Sam about the invoice')
    // 3pm tomorrow in Bangkok is 08:00 UTC.
    expect(call.due).toMatch(/T08:00:00/)
    expect(await cards(id)).toHaveLength(2)
    const [made] = await t.db.select().from(boardActivity).where(eq(boardActivity.command, 'task.create'))
    expect(made).toMatchObject({ actorId: ann.user.id, via: 'Telegram' })

    const [, first, second] = said()
    expect(first.text).toMatch(/^Added to <b>My first board<\/b>\nRenew the domain\n<a href="[^"]+\?task=[^"]+">Open ›<\/a>$/)
    expect(first.reply_markup!.inline_keyboard[0].map((b) => b.text)).toEqual(['Undo'])
    expect(second.text).toMatch(/^Added to <b>My first board<\/b>\nCall Sam about the invoice\nDue \w{3} \d+ \w{3}, 15:00\n<a /)
    expect(second.reply_markup!.inline_keyboard[0].map((b) => b.text)).toEqual(['Undo', 'No date'])

    // The chat isn't told again what it just did itself (the bot answered there); what happens elsewhere, it is.
    expect(await deliver()).toBe(0)
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: call.id, fields: { title: 'Call Sam' } },
    })
    expect(await deliver()).toBe(1)
    expect(said().at(-1)!.text).toMatch(/^Ann renamed “Call Sam about the invoice” to /)

    // The same message asked for twice by a server that fell over in between makes no second card.
    await t.db.update(telegramBots).set({ readFrom: null })
    await bot.poll()
    expect(await cards(id)).toHaveLength(2)
  })

  it('photos and files are attached; one that is refused never loses the card; photos sent together are one card', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

    send(bot.token, own(ANN), ANN, undefined, { caption: 'Receipt for the printer', photo: [t.telegram.file('', png)] })
    send(bot.token, own(ANN), ANN, undefined, { document: t.telegram.file('notes.txt', Buffer.from('hello')) })
    // Bigger than the site's largest file (10 MB), by what Telegram says of it.
    send(bot.token, own(ANN), ANN, undefined, {
      caption: 'The film',
      video: { ...t.telegram.file('film.mp4', Buffer.from('x')), file_size: 15 * 1024 * 1024 },
    })
    send(bot.token, own(ANN), ANN, undefined, { document: t.telegram.file('setup.exe', Buffer.from('MZ')) })
    await bot.poll()
    const [receipt, notes, film, program] = await cards(id)
    expect([receipt.title, notes.title, film.title, program.title]).toEqual(['Receipt for the printer', 'notes.txt', 'The film', 'setup.exe'])
    const files = await t.db.select().from(attachments).where(eq(attachments.boardId, id))
    expect(files.map((f) => [f.taskId, f.name.replace(/\d{4}-\d\d-\d\d-\d\d-\d\d/, 'when')])).toEqual([
      [receipt.id, 'photo-when.jpg'],
      [notes.id, 'notes.txt'],
    ])
    const answers = said().slice(1)
    expect(answers[0].text).toMatch(/^Added to <b>My first board<\/b>, with 1 file\nReceipt for the printer\n/)
    expect(answers[2].text).toMatch(/A file wasn’t attached: it is bigger than 10 MB\./)
    expect(answers[3].text).toMatch(/A file wasn’t attached: /)

    // An album: its photos arrive one by one, and join the first one's card.
    send(bot.token, own(ANN), ANN, undefined, { caption: 'The stand', photo: [t.telegram.file('', png)], media_group_id: 'g1' })
    send(bot.token, own(ANN), ANN, undefined, { photo: [t.telegram.file('', png)], media_group_id: 'g1' })
    await bot.poll()
    const all = await cards(id)
    expect(all).toHaveLength(5)
    expect((await t.db.select().from(attachments).where(eq(attachments.taskId, all[4].id))).length).toBe(2)
    expect((t.telegram.did('editMessageText').at(-1) as { text: string }).text).toMatch(/with 2 files\nThe stand/)

    // Nothing to make a card of.
    send(bot.token, own(ANN), ANN, undefined)
    await bot.poll()
    expect(said().at(-1)!.text).toBe('I can take words, photos and files.')
  })

  it('a forwarded message says who it came from, and its words aren’t read as a date; /help says how it works', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    send(bot.token, own(ANN), ANN, 'Offer ends tomorrow 3pm', { forward_origin: { type: 'user', sender_user: BEN } })
    send(bot.token, own(ANN), ANN, '/help')
    await bot.poll()
    const [card] = await cards(id)
    expect(card).toMatchObject({ title: 'Offer ends tomorrow 3pm', description: 'Forwarded from Ben Ortiz', due: null })
    expect(said().at(-1)!.text).toMatch(/Send me a message and it becomes a card[\s\S]*Reply to my answer/)
  })

  it('goes to the list the owner picked; switched off, the bot only posts news', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    expect((await ann.request('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { cardsTo: 'nowhere' })).status).toBe(400)
    await ann.ok('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { cardsTo: 'doing' })
    send(bot.token, own(ANN), ANN, 'Already started')
    await bot.poll()
    expect((await cards(id))[0]).toMatchObject({ title: 'Already started', status: 'doing' })

    await ann.ok('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { takesCards: false })
    send(bot.token, own(ANN), ANN, 'Not a card')
    await bot.poll()
    expect(await cards(id)).toHaveLength(1)
    expect(said().at(-1)!.text).toMatch(/only posts the board’s news/)

    // A new token for the same bot is taken; another bot's isn't.
    const another = t.telegram.bot('other_bot')
    expect(await ann.request('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { token: another })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/another bot \(@other_bot\)/) },
    })
    await ann.ok('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { token: bot.token })
  })
})

describe('after the card: the buttons, an edit, a reply', () => {
  const setUp = async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    const m = send(bot.token, own(ANN), ANN, 'Review May report friday')
    await bot.poll()
    const [row] = await t.db.select().from(telegramCards)
    const tap = async (data: string, from: TgUser = ANN) => {
      t.telegram.push(bot.token, {
        callback_query: { id: `q${++n}`, from, data, message: message(own(ANN), ANN, undefined, { message_id: row.answerId! }) },
      })
      await bot.poll()
      return (t.telegram.did('answerCallbackQuery').at(-1) as { text?: string }).text
    }
    const card = async () =>
      (
        await t.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.boardId, id), eq(tasks.id, row.taskId)))
      )[0]
    return { ann, id, bot, m, row, tap, card }
  }

  it('“No date” puts the words back in the title; “Undo” archives the card', async () => {
    const { tap, card } = await setUp()
    expect(await card()).toMatchObject({ title: 'Review May report' })
    expect((await card()).due).toMatch(/^\d{4}-\d\d-\d\d$/)
    expect(await tap('nodate')).toBe('No date')
    expect(await card()).toMatchObject({ title: 'Review May report friday', due: null })
    const rewritten = t.telegram.did('editMessageText').at(-1) as { text: string; reply_markup: { inline_keyboard: { text: string }[][] } }
    expect(rewritten.text).toMatch(/^Added to <b>My first board<\/b>\nReview May report friday\n<a /)
    expect(rewritten.reply_markup.inline_keyboard[0].map((b) => b.text)).toEqual(['Undo'])

    expect(await tap('undo')).toBe('Taken back')
    expect((await card()).archivedAt).not.toBeNull()
    expect((t.telegram.did('editMessageText').at(-1) as { text: string }).text).toBe(
      'Taken back: “Review May report friday”. It’s in the archive of My first board if you want it again.',
    )
    // (Once is enough.)
    expect(await tap('undo')).toMatch(/a while ago/)
  })

  it('the buttons work for a day', async () => {
    const { tap, card, row } = await setUp()
    await t.db
      .update(telegramCards)
      .set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(telegramCards.id, row.id))
    expect(await tap('undo')).toBe('That was a while ago. Change the card in Kanbanto.')
    expect((await card()).archivedAt).toBeNull()
  })

  it('an edited message changes the card, until the card was changed in Kanbanto', async () => {
    const { ann, id, bot, m, card } = await setUp()
    t.telegram.push(bot.token, { edited_message: { ...m, text: 'Review the sales report\nWith the new numbers' } })
    await bot.poll()
    expect(await card()).toMatchObject({ title: 'Review the sales report', description: 'With the new numbers', due: null })
    expect((t.telegram.did('editMessageText').at(-1) as { text: string }).text).toMatch(/\nReview the sales report\n/)

    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: (await card()).id, fields: { description: 'Rewritten in the app' } },
    })
    t.telegram.push(bot.token, { edited_message: { ...m, text: 'Review the other report' } })
    await bot.poll()
    expect(await card()).toMatchObject({ title: 'Review the sales report', description: 'Rewritten in the app' })
    expect(said().at(-1)!.text).toMatch(/^This card was changed in Kanbanto since, so I left it as it is\./)
  })

  it('a reply to the bot’s answer is a comment on the card, with its file', async () => {
    const { id, bot, row } = await setUp()
    const answer = message(own(ANN), { id: 1, is_bot: true, first_name: 'launch_bot' }, 'Added…', { message_id: row.answerId! })
    send(bot.token, own(ANN), ANN, 'The numbers are in the shared folder', { reply_to_message: answer })
    send(bot.token, own(ANN), ANN, undefined, {
      caption: 'And the chart',
      document: t.telegram.file('chart.txt', Buffer.from('1,2,3')),
      reply_to_message: answer,
    })
    await bot.poll()
    const posted = await t.db.select().from(comments).where(eq(comments.boardId, id))
    expect(posted.map((c) => [c.taskId, c.body])).toEqual([
      [row.taskId, 'The numbers are in the shared folder'],
      [row.taskId, 'And the chart'],
    ])
    const [file] = await t.db.select().from(attachments).where(eq(attachments.boardId, id))
    expect(file).toMatchObject({ name: 'chart.txt', commentId: posted[1].id })
    expect(said().at(-2)!.text).toBe('Added as a comment on “Review May report”.')
    expect(said().at(-1)!.text).toBe('Added as a comment on “Review May report”, with the file.')
    // No card was made of either.
    expect(await cards(id)).toHaveLength(1)
    // (Nor is the chat told about its own comments.)
    expect(await deliver()).toBe(0)
  })
})

describe('a bot in a group', () => {
  it('adds a card for /card, from anyone there, and makes a card of a message replied to with /card', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(GROUP, ANN)
    expect(said()[0].text).toMatch(/Send \/card and a title to add a card/)

    // What people say to each other is none of the bot's business (and Telegram doesn't show it most of it).
    const broken = send(bot.token, GROUP, BEN, 'the signup page is broken on iPhone')
    send(bot.token, GROUP, ANN, '/card@another_bot Not mine')
    await bot.poll()
    expect(await cards(id)).toHaveLength(0)

    send(bot.token, GROUP, ANN, '/card Fix the pricing page')
    send(bot.token, GROUP, BEN, '/card@launch_bot Order the banner')
    send(bot.token, GROUP, ANN, '/card', { reply_to_message: broken })
    send(bot.token, GROUP, ANN, '/card')
    await bot.poll()
    const [pricing, banner, signup] = await cards(id)
    expect(pricing).toMatchObject({ title: 'Fix the pricing page', description: null })
    // Ben isn't known here: his card goes in the name of who connected the bot, and says it's from him.
    expect(banner).toMatchObject({ title: 'Order the banner', description: 'From Ben Ortiz' })
    expect(signup).toMatchObject({ title: 'the signup page is broken on iPhone', description: 'From Ben Ortiz' })
    const answers = said().slice(1)
    expect(answers[0].text).toMatch(/^Added to <b>My first board<\/b> by Ann\nFix the pricing page\n/)
    expect(answers[1].text).toMatch(/by Ann\nOrder the banner\nFrom Ben Ortiz\n/)
    expect(answers[3].text).toBe('Say what the card is: /card Fix the sign-up page')

    // Only who added a card can take it back.
    const [first] = await t.db.select().from(telegramCards).where(eq(telegramCards.taskId, pricing.id))
    t.telegram.push(bot.token, {
      callback_query: { id: 'q1', from: BEN, data: 'undo', message: message(GROUP, ANN, undefined, { message_id: first.answerId! }) },
    })
    await bot.poll()
    expect((t.telegram.did('answerCallbackQuery').at(-1) as { text: string }).text).toBe('Only the person who added it can do that.')
    expect((await cards(id))[0].archivedAt).toBeNull()
  })

  it('knows someone by the bot on their own Inbox: their cards are theirs', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(GROUP, ANN)
    const ben = await Person.signUp(t.app, 'Ben')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'ben@example.com', role: 'editor' })
    const { boardId: inbox } = await ben.ok('POST', '/api/inbox')
    const mine = await addBot(ben, inbox, 'ben_inbox_bot')
    await mine.connect(own(BEN), BEN)
    expect(said().at(-1)!.text).toMatch(/^Kanbanto will post news from your Inbox here\./)

    send(bot.token, GROUP, BEN, '/card Order the banner')
    await bot.poll()
    const [banner] = await cards(id)
    expect(banner).toMatchObject({ title: 'Order the banner', description: null })
    const [made] = await t.db
      .select()
      .from(boardActivity)
      .where(and(eq(boardActivity.boardId, id), eq(boardActivity.command, 'task.create')))
    expect(made.actorId).toBe(ben.user.id)
    expect(said().at(-1)!.text).toMatch(/by Ben\nOrder the banner\n/)

    // What Ben sends his own bot lands in his Inbox.
    send(mine.token, own(BEN), BEN, 'Buy milk')
    await mine.poll()
    expect((await t.db.select().from(tasks).where(eq(tasks.boardId, inbox))).map((c) => c.title)).toContain('Buy milk')
    expect(said().at(-1)!.text).toMatch(/^Added to your Inbox\nBuy milk\n/)
  })

  it('stops taking cards when whoever connected it can no longer edit the board; is paused when the group removes it', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(GROUP, ANN)
    await t.db.update(webhooks).set({ createdBy: null })
    send(bot.token, GROUP, BEN, '/card Order the banner')
    await bot.poll()
    expect(await cards(id)).toHaveLength(0)
    expect(said().at(-1)!.text).toMatch(/can no longer edit the board/)

    t.telegram.push(bot.token, { my_chat_member: { chat: GROUP, new_chat_member: { status: 'left' } } })
    await bot.poll()
    const [hook] = (await ann.ok('GET', `/api/boards/${id}/webhooks`)).webhooks
    expect(hook).toMatchObject({ active: false, telegram: { problem: expect.stringMatching(/removed from the chat/) } })
  })
})

describe('your own news, through a bot you connected to your own chat', () => {
  it('mentions and reminders come to your chat with the board’s bot, each with its own switch; followed cards only if you ask', async () => {
    const { ann, id } = await site()
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    const mine = await addBot(ann, inbox, 'ann_inbox_bot')
    await mine.connect(own(ANN), ANN)
    const onBoard = await addBot(ann, id, 'ann_board_bot')
    await onBoard.connect(own(ANN), ANN)
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    // Her own news (said with its title in bold), apart from what the board's bot says as the board's news.
    const news = () =>
      said()
        .map((m) => m.text)
        .filter((text) => /^<b>(Bob |⏰)/.test(text))
    const settle = () => new Promise((r) => setTimeout(r, 150))

    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Can you look, @Ann?', mentions: [ann.user.id] })
    await settle()
    expect(news()).toHaveLength(1)
    expect(news()[0]).toMatch(/^<b>Bob mentioned you<\/b>\n“Launch website”: Can you look, @⁠Ann\?\n<a href="[^"]+\?task=A">Open ›<\/a>$/)

    // Ann follows the card now; what Bob does to it reaches Telegram only once she asks for that.
    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Never mind' })
    await settle()
    expect(news()).toHaveLength(1)
    await ann.ok('PATCH', '/api/auth/me', { telegramFollows: true })
    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Done now' })
    await settle()
    expect(news().at(-1)).toMatch(/^<b>Bob commented on “Launch website”<\/b>\nDone now\n/)

    await ann.ok('PATCH', '/api/auth/me', { telegramMentions: false })
    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'And again, @Ann', mentions: [ann.user.id] })
    await settle()
    expect(news()).toHaveLength(2)

    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: {
        type: 'task.update',
        id: 'A',
        fields: { assigneeId: ann.user.id, due: '2026-10-07T11:00:00Z', reminders: [{ id: 'r1', at: new Date(Date.now() - 60_000).toISOString() }] },
      },
    })
    expect(await sendReminders(t.app)).toBe(1)
    // The time it's due is said as her clock reads (her account is on Bangkok time): 11:00 UTC is 6pm there.
    expect(news().at(-1)).toMatch(/^<b>⏰ Launch website<\/b>\nMy first board · due Wed 7 Oct, 18:00\n/)

    // A reminder on a card of the Inbox itself: its bot's chat hears it once, not also as the Inbox's own news.
    send(mine.token, own(ANN), ANN, 'Water the plants')
    await mine.poll()
    const [plant] = await cards(inbox)
    const before = said().length
    await ann.ok('POST', `/api/boards/${inbox}/mutations`, {
      mutationId: mid(),
      command: {
        type: 'task.update',
        id: plant.id,
        fields: { due: '2026-10-07T11:00:00Z', reminders: [{ id: 'r2', at: new Date(Date.now() - 60_000).toISOString(), by: ann.user.id }] },
      },
    })
    // An account with no time zone is told in UTC, and the message says so.
    await ann.ok('PATCH', '/api/auth/me', { timeZone: null })
    expect(await sendReminders(t.app)).toBe(1)
    await deliver()
    const after = said()
      .slice(before)
      .map((m) => m.text)
    expect(after.filter((text) => text.includes('Water the plants'))).toHaveLength(1)
    expect(after[0]).toMatch(/^<b>⏰ Water the plants<\/b>\nInbox · due Wed 7 Oct, 11:00 UTC\n/)
  })
})

describe('your own news, through your bot on the card’s board', () => {
  it('a bot on a board, in your own chat, tells you your reminders and mentions on that board, each thing once, and nothing of another board', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    const texts = () =>
      said()
        .slice(1)
        .map((m) => m.text)
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 200))
      await t.app.webhooks.process()
    }

    // A mention on the bot's own board: told as Ann's own news, and not again as the board's news of the comment.
    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Can you look, @Ann?', mentions: [ann.user.id] })
    await settle()
    expect(texts()).toHaveLength(1)
    expect(texts()[0]).toMatch(/^<b>Bob mentioned you<\/b>/)

    // A comment that isn't Ann's own news (she has follows switched off) is still the board's news.
    await bob.ok('POST', `/api/boards/${id}/tasks/B/comments`, { body: 'Invites are out' })
    await settle()
    expect(texts()).toHaveLength(2)
    expect(texts()[1]).toMatch(/^Bob commented on .*“Event”.* on My first board: Invites are out$/)

    // A reminder on another board, which has no bot: it isn't this bot's to say, nor the one on her Inbox's. (It is
    // still sent: the bell and email have it.)
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    const mine = await addBot(ann, inbox, 'ann_inbox_bot')
    await mine.connect(own(ANN), ANN)
    expect((await ann.ok('GET', '/api/account/telegram')).bots).toEqual([
      { bot: 'launch_bot', board: 'My first board', inbox: false },
      { bot: 'ann_inbox_bot', board: 'Inbox', inbox: true },
    ])
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Other' })
    await ann.ok('POST', `/api/boards/${other}/mutations`, {
      mutationId: mid(),
      command: {
        type: 'task.create',
        id: 'X1',
        parentId: null,
        fields: { title: 'Pay rent', reminders: [{ id: 'r1', at: new Date(Date.now() - 60_000).toISOString(), by: ann.user.id }] },
      },
    })
    expect(await sendReminders(t.app)).toBe(1)
    await settle()
    expect(texts().filter((text) => text.includes('Pay rent'))).toEqual([])

    // A reminder on the bot's own board: once, as her own, not also as the board's.
    const count = texts().length
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: {
        type: 'task.update',
        id: 'A3',
        fields: { assigneeId: ann.user.id, reminders: [{ id: 'r2', at: new Date(Date.now() - 60_000).toISOString() }] },
      },
    })
    await settle()
    const before = texts().length
    expect(before).toBe(count + 1) // (the change itself, as the board's news)
    expect(await sendReminders(t.app)).toBe(1)
    await settle()
    expect(texts().slice(before)).toEqual([expect.stringMatching(/^<b>⏰ Deploy<\/b>\nMy first board/)])

    // With changes on followed cards switched on: the board's bot already says them, so they aren't said twice.
    await ann.ok('PATCH', '/api/auth/me', { telegramFollows: true })
    const then = texts().length
    await bob.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.update', id: 'A3', fields: { status: 'done' } } })
    await settle()
    expect(texts().slice(then)).toEqual([expect.stringMatching(/^Bob moved .*“Deploy”.* to Done on My first board$/)])
  })

  it('a bot in a group tells nobody their own news', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(GROUP, ANN)
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'Can you look, @Ann?', mentions: [ann.user.id] })
    await new Promise((r) => setTimeout(r, 200))
    await t.app.webhooks.process()
    // (The group hears the comment as the board's news; nobody is written to on their own.)
    expect(
      said()
        .slice(1)
        .map((m) => m.text),
    ).toEqual([expect.stringMatching(/^Bob commented on /)])
    expect(await ann.ok('GET', '/api/account/telegram')).toEqual({ allowed: true, bots: [] })
  })
})

describe('the menu: shortcuts that answer in the chat', () => {
  const menus = () => t.telegram.did('setMyCommands') as { commands: { command: string }[]; scope?: { type: string; chat_id: number } }[]
  const menuOf = (chat: number) =>
    menus()
      .filter((m) => m.scope?.chat_id === chat)
      .at(-1)
      ?.commands.map((c) => c.command)

  it('each chat is offered what works there; /board gives the way in, /list the cards waiting', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(GROUP, ANN)
    expect(menuOf(GROUP.id)).toEqual(['card', 'list', 'board', 'help'])
    // (Anywhere else, the bot has no menu.)
    expect(menus().some((m) => !m.scope && m.commands.length === 0)).toBe(true)

    send(bot.token, GROUP, BEN, '/board')
    send(bot.token, GROUP, BEN, '/list@launch_bot')
    await bot.poll()
    const [board, list] = said().slice(-2)
    expect(board.text).toBe(`<b>My first board</b> in Kanbanto: <a href="https://kanbanto.example/#/b/${id}">Open ›</a>`)
    const lines = list.text.split('\n')
    expect(lines[0]).toMatch(/^<b>To Do<\/b> on <b>My first board<\/b>: \d+ cards$/)
    // (On this board a task's status follows its subtasks, so the list holds the pieces of work themselves.)
    expect(lines[1]).toMatch(/^• <a href="https:\/\/kanbanto\.example\/#\/b\/[^"]+\?task=A2b">Logo<\/a> · due /)
    expect(lines.at(-1)).toBe(`<a href="https://kanbanto.example/#/b/${id}">Open the board ›</a>`)
    // No card was made of a shortcut, and /today is for someone's own Inbox.
    expect(await cards(id)).toHaveLength(0)
    send(bot.token, GROUP, BEN, '/today')
    await bot.poll()
    expect(said().at(-1)!.text).toBe('That works in your own chat with a bot.')

    // The list is the one new cards go to; a bot that only posts news has no menu.
    await ann.ok('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { cardsTo: 'doing' })
    send(bot.token, GROUP, BEN, '/list')
    await bot.poll()
    expect(said().at(-1)!.text).toMatch(/^<b>Doing<\/b> on <b>My first board<\/b>/)
    await ann.ok('PATCH', `/api/boards/${id}/webhooks/${bot.hookId}/telegram`, { takesCards: false })
    expect(menuOf(GROUP.id)).toEqual([])
  })

  it('/today, in your own chat: what is yours on that bot’s board and overdue, due today and tomorrow, and your reminders in the next 24 hours', async () => {
    const { ann, id } = await site()
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    const mine = await addBot(ann, inbox, 'ann_inbox_bot')
    await mine.connect(own(ANN), ANN)
    expect(menuOf(ANN.id)).toEqual(['list', 'today', 'board', 'help'])
    expect(await ann.ok('GET', '/api/account/telegram')).toEqual({ allowed: true, bots: [{ bot: 'ann_inbox_bot', board: 'Inbox', inbox: true }] })
    expect(said().at(-1)!.text).toMatch(
      /Send \/today for what is due today and tomorrow, what is overdue, and your reminders in the next 24 hours, on this board\./,
    )

    send(mine.token, own(ANN), ANN, '/today')
    await mine.poll()
    expect(said().at(-1)!.text).toBe(
      'Nothing is due today or tomorrow in your Inbox, nothing is overdue, and no reminder is set for the next 24 hours.',
    )
    // A second bot of hers, on the board, in her own chat with it.
    const boards = await addBot(ann, id, 'ann_board_bot')
    await boards.connect(own(ANN), ANN)
    send(boards.token, own(ANN), ANN, '/today')
    await boards.poll()
    expect(said().at(-1)!.text).toBe(
      'Nothing is due today or tomorrow on <b>My first board</b>, nothing is overdue, and no reminder is set for the next 24 hours.',
    )

    const day = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10)
    const set = (taskId: string, fields: object) =>
      ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'task.update', id: taskId, fields } })
    // Hers by being assigned; a reminder of hers two hours from now; one due later in the week, which isn't shown.
    await set('A3', {
      assigneeId: ann.user.id,
      due: day(0),
      reminders: [{ id: 'r1', at: new Date(Date.now() + 2 * 3600_000).toISOString(), by: ann.user.id }],
    })
    await set('B1', { assigneeId: ann.user.id, due: day(-2) })
    await set('A2b', { assigneeId: ann.user.id, due: day(3) })
    // Nobody is assigned this one: on a board where she is the only person, it is hers too.
    await set('A2a', { assigneeId: null, due: day(1) })
    // And a card she sent the bot, which is on her Inbox with nobody assigned.
    send(mine.token, own(ANN), ANN, 'Water the plants today')
    send(mine.token, own(ANN), ANN, '/today')
    await mine.poll()
    // Each bot answers for its own board. The Inbox's: the card she sent it, and nothing of the board's.
    expect(said().at(-1)!.text.split('\n')).toEqual([
      'Your Inbox',
      '<b>Due today</b>',
      expect.stringMatching(/^• <a href="[^"]+">Water the plants<\/a>$/),
      `<a href="https://kanbanto.example/#/b/${inbox}">Open the board ›</a>`,
    ])
    // The board's: what is hers there, and nothing of her Inbox.
    send(boards.token, own(ANN), ANN, '/today')
    await boards.poll()
    const lines = said().at(-1)!.text.split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('<b>My first board</b>')
    expect(lines[1]).toBe('<b>Overdue</b>')
    expect(lines[2]).toMatch(/^• <a href="[^"]+\?task=B1">Send invites<\/a> · was due \w{3} \d+ \w{3}$/)
    expect(lines[3]).toBe('<b>Due today</b>')
    expect(lines[4]).toMatch(/^• <a href="[^"]+\?task=A3">Deploy<\/a>$/)
    expect(lines[5]).toBe('<b>Due tomorrow</b>')
    expect(lines[6]).toMatch(/^• <a href="[^"]+\?task=A2a">Homepage<\/a>$/)
    expect(lines[7]).toBe('<b>Reminders in the next 24 hours</b>')
    expect(lines[8]).toMatch(/^• <a href="[^"]+\?task=A3">Deploy<\/a> · \w{3} \d+ \w{3}, \d\d:\d\d$/)
    expect(lines[9]).toBe(`<a href="https://kanbanto.example/#/b/${id}">Open the board ›</a>`)

    // A card with a time: its time is said. A finished one is left out.
    await set('A3', { due: `${day(0)}T16:59:00Z`, reminders: [] })
    await set('B1', { status: 'done' })
    send(boards.token, own(ANN), ANN, '/today')
    await boards.poll()
    const again = said().at(-1)!.text
    expect(again).not.toContain('Overdue')
    expect(again).not.toContain('Reminders')
    expect(again).toMatch(/>Deploy<\/a> · 23:59\n/)
    // (A shortcut is never a card: the Inbox has the one she sent.)
    expect(await cards(inbox)).toHaveLength(1)
  })

  it('on a site Telegram can’t link to (this computer), the address is shown to copy instead of a dead link', async () => {
    const { ann, id } = await site()
    t.app.mail.siteUrl = 'http://localhost:5173'
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    send(bot.token, own(ANN), ANN, 'Renew the domain')
    send(bot.token, own(ANN), ANN, '/list')
    await bot.poll()
    const [added, list] = said().slice(-2)
    expect(added.text).toMatch(/^Added to <b>My first board<\/b>\nRenew the domain\n<code>http:\/\/localhost:5173\/#\/b\/[^<]+\?task=[^<]+<\/code>$/)
    expect(list.text).not.toContain('<a ')
    expect(list.text).toMatch(/\n• Logo · due /)
    expect(list.text.endsWith(`<code>http://localhost:5173/#/b/${id}</code>`)).toBe(true)
  })
})

describe('limits', () => {
  it('a chat can add twenty cards a minute', async () => {
    const { ann, id } = await site()
    const bot = await addBot(ann, id, 'launch_bot')
    await bot.connect(own(ANN), ANN)
    for (let i = 1; i <= 21; i++) send(bot.token, own(ANN), ANN, `Card ${i}`)
    await bot.poll()
    expect(await cards(id)).toHaveLength(20)
    expect(said().at(-1)!.text).toBe('That’s a lot at once. Try again in a minute.')
  })
})

/**
 * Against Telegram itself: only when asked, with the token of a bot made for it at @BotFather.
 *
 *   TELEGRAM_TEST_TOKEN=123456789:AAH… pnpm --filter @kanbanto/server exec vitest run test/telegram.test.ts
 *
 * With TELEGRAM_TEST_CHAT (the id of a chat that has started the bot), a message is sent there too, as a board's
 * news would be: a card called "@everyone <b>bold</b>", for someone to look at.
 */
const realToken = process.env.TELEGRAM_TEST_TOKEN
describe.skipIf(!realToken)('Telegram itself', () => {
  it('knows the bot, hands over what is waiting for it, and takes a message', async () => {
    const api = telegramApi('https://api.telegram.org')
    const me = await api.call<{ id: number; username: string; is_bot: boolean }>(realToken!, 'getMe')
    expect(me.is_bot).toBe(true)
    expect(Array.isArray(await api.call(realToken!, 'getUpdates', { timeout: 0, limit: 1 }))).toBe(true)
    await expect(api.call('1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'getMe')).rejects.toMatchObject({ status: expect.any(Number) })
    const chat = process.env.TELEGRAM_TEST_CHAT
    if (chat) {
      const body = chatBody('telegram', {
        lines: [[{ text: 'Ann added ' }, { text: '“@everyone <b>bold</b>”', url: 'https://kanbanto.com' }, { text: ' on Launch' }]],
      })
      expect(await api.call<{ message_id: number }>(realToken!, 'sendMessage', { chat_id: Number(chat), ...body })).toMatchObject({
        message_id: expect.any(Number),
      })
    }
  })
})

describe('/help and the guide', () => {
  it('say the same: every line of the bot’s help is in the guide, word for word', () => {
    const guide = readFileSync(new URL('../../../guides/more/telegram.md', import.meta.url), 'utf8')
    for (const line of Object.values(HELP).flat()) expect(guide, line).toContain(line)
  })
})
