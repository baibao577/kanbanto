import type { CommentView, NotificationView } from '@kanbanto/model/api'
import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { commentReactions, notifications, users } from '../src/db/schema'
import type { LiveMessage } from '../src/live'
import { sendDigests } from '../src/mail/digest'
import { Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

type Told = NotificationView & { kind: 'reaction' }
const react = (p: Person, board: string, comment: string, emoji: string, on = true) =>
  p.request<{ comment: CommentView; error?: string }>('PUT', `/api/boards/${board}/comments/${comment}/reactions`, { emoji, on })
const commentsOf = async (p: Person, board: string, task = 'A3') =>
  (await p.ok<{ comments: CommentView[] }>('GET', `/api/boards/${board}/tasks/${task}/comments`)).comments
/** A comment's reactions in a few words: "👍 Bob, Vic · 🎉 Bob". */
const said = (c: CommentView) => c.reactions.map((r) => `${r.emoji} ${r.by.map((p) => p.name).join(', ')}`).join(' · ')
const bell = async (p: Person): Promise<Told[]> =>
  (await p.ok('GET', '/api/notifications')).notifications.filter((n: { kind: string }) => n.kind === 'reaction')
const unread = async (p: Person) => (await p.ok('GET', '/api/notifications')).unread as number

/** Ann owns the example board and has commented on Deploy (A3); Bob can edit the board and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  const { comment } = await ann.ok<{ comment: CommentView }>('POST', `/api/boards/${id}/tasks/A3/comments`, {
    body: 'Deployed to staging. Please try it.',
  })
  await Promise.all([ann, bob, vic].map((p) => p.ok('POST', '/api/notifications/read', {})))
  return { ann, bob, vic, id, comment }
}

describe('reactions on a comment', () => {
  it('are added and taken back by everyone who can comment, one of each to a person', async () => {
    const { ann, bob, vic, id, comment } = await team()
    expect(comment.reactions).toEqual([])
    const first = await react(bob, id, comment.id, '👍')
    expect(first.status).toBe(200)
    expect(first.body.comment.reactions).toEqual([{ emoji: '👍', by: [{ id: bob.user.id, name: 'Bob' }] }])
    // Again changes nothing; another emoji is another reaction; a viewer reacts too; so can the author.
    await react(bob, id, comment.id, '👍')
    await react(bob, id, comment.id, '✅')
    await react(vic, id, comment.id, '👍')
    await react(ann, id, comment.id, '🎉')
    // In the order they're offered, each with its people in the order they reacted.
    expect(said((await commentsOf(ann, id))[0])).toBe('👍 Bob, Vic · 🎉 Ann · ✅ Bob')
    expect(await t.db.select().from(commentReactions)).toHaveLength(4)
    // Taken back: only your own, only that one.
    expect(said((await react(bob, id, comment.id, '👍', false)).body.comment)).toBe('👍 Vic · 🎉 Ann · ✅ Bob')
    await react(bob, id, comment.id, '🎉', false)
    expect(said((await commentsOf(vic, id))[0])).toBe('👍 Vic · 🎉 Ann · ✅ Bob')
  })

  it('are from the set, on a comment of that board, and not for visitors', async () => {
    const { ann, bob, id, comment } = await team()
    const refused = async (p: Person, board: string, c: string, emoji: string) => {
      const r = await react(p, board, c, emoji)
      return [r.status, r.body.error]
    }
    expect(await refused(bob, id, comment.id, '👎')).toEqual([400, 'That isn’t one of the reactions to choose from.'])
    expect(await refused(bob, id, comment.id, 'thumbs up')).toEqual([400, 'That isn’t one of the reactions to choose from.'])
    expect((await refused(bob, id, '01a11b66-d5cd-74d4-8517-8fb68bd7b4ec', '👍'))[0]).toBe(404)
    // A comment of another board isn't reached through this one.
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Ops', template: 'example' })
    expect((await refused(ann, other, comment.id, '👍'))[0]).toBe(404)
    // A visitor with the public link sees the reactions and can't add any; a stranger sees nothing.
    await react(bob, id, comment.id, '👀')
    const sam = await Person.signUp(t.app, 'Sam')
    expect((await react(sam, id, comment.id, '👍')).status).toBe(404)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    expect(await refused(sam, id, comment.id, '👍')).toEqual([403, 'Join this board to react to its comments.'])
    expect((await react(new Person(t.app), id, comment.id, '👍')).status).toBe(401)
    expect(said((await commentsOf(new Person(t.app), id))[0])).toBe('👀 Bob')
  })

  it('tell the comment’s author under the bell, in one line for the comment, and never by email', async () => {
    const { ann, bob, vic, id, comment } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await t.db.update(users).set({ emailVerifiedAt: new Date() })
    const sent: { title: string }[] = []
    t.app.push.transport = async (_sub, payload) => void sent.push(JSON.parse(payload))
    await ann.ok('POST', '/api/push/devices', { endpoint: 'https://push.example.com/ann-1', keys: { p256dh: 'BPk', auth: 'aa' }, label: 'Chrome' })

    await react(bob, id, comment.id, '👍')
    expect(await bell(ann)).toMatchObject([
      {
        kind: 'reaction',
        actor: 'Bob',
        board: { id },
        task: { id: 'A3', title: 'Deploy' },
        people: ['Bob'],
        emoji: ['👍'],
        excerpt: 'Deployed to staging. Please try it.',
        read: false,
      },
    ])
    // More reactions join the line she hasn't read; her own don't tell her, and nobody else is told.
    await react(vic, id, comment.id, '🎉')
    await react(bob, id, comment.id, '🎉')
    await react(ann, id, comment.id, '❤️')
    const [line, ...rest] = await bell(ann)
    expect(rest).toEqual([])
    expect([line.actor, line.people, line.emoji]).toEqual(['Bob', ['Bob', 'Vic'], ['👍', '🎉']])
    expect(await unread(ann)).toBe(1)
    expect(await bell(bob)).toEqual([])
    expect(await bell(vic)).toEqual([])
    // Quieter than a comment: nothing on the desktop, nothing in the morning email.
    await new Promise((r) => setTimeout(r, 150))
    expect(sent).toEqual([])
    expect(await sendDigests(t.app, new Date('2026-10-01T08:05:00Z'))).toBe(0)
    // Once read, the next reaction brings the same line back, unread, with the latest person first.
    await ann.ok('POST', '/api/notifications/read', {})
    expect(await unread(ann)).toBe(0)
    await react(vic, id, comment.id, '👀')
    expect((await bell(ann)).map((n) => [n.actor, n.people, n.emoji, n.read])).toEqual([['Vic', ['Vic', 'Bob'], ['👍', '🎉', '👀'], false]])
    expect(await unread(ann)).toBe(1)
  })

  it('leave no line behind when they are all taken back', async () => {
    const { ann, bob, vic, id, comment } = await team()
    await react(bob, id, comment.id, '👍')
    await react(vic, id, comment.id, '👍')
    await react(bob, id, comment.id, '👍', false)
    expect((await bell(ann))[0].people).toEqual(['Vic'])
    await react(vic, id, comment.id, '👍', false)
    expect(await bell(ann)).toEqual([])
    expect(await unread(ann)).toBe(0)
    // A line she had read goes too once nothing is left of it.
    await react(bob, id, comment.id, '✅')
    await ann.ok('POST', '/api/notifications/read', {})
    await react(bob, id, comment.id, '✅', false)
    expect(await bell(ann)).toEqual([])
    // Someone who has left the board is not told.
    await ann.ok('PATCH', `/api/boards/${id}/members/${bob.user.id}`, { role: 'owner' })
    const { comment: bobs } = await bob.ok<{ comment: CommentView }>('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'On it.' })
    await ann.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    await react(ann, id, bobs.id, '👍')
    expect(
      await t.db
        .select()
        .from(notifications)
        .then((rows) => rows.filter((n) => n.kind === 'reaction')),
    ).toEqual([])
    expect(await bell(bob)).toEqual([])
  })

  it('reach everyone who has the card open, and go with the comment', async () => {
    const { ann, bob, id, comment } = await team()
    const messages: LiveMessage[] = []
    const ws: WebSocket = await t.app.injectWS(`/api/boards/${id}/live`, { headers: { cookie: ann.cookie! } })
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
    await react(bob, id, comment.id, '👀')
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'comment'); i++) await new Promise((r) => setTimeout(r, 20))
    ws.close()
    const live = messages.find((m) => m.type === 'comment')
    expect(live).toMatchObject({ type: 'comment', taskId: 'A3', action: 'reacted', commentId: comment.id })
    expect(said((live as { comment: CommentView }).comment)).toBe('👀 Bob')
    // Moved to another board with its card: the comment keeps its reactions there.
    const { id: shop } = await ann.ok('POST', '/api/boards', { name: 'Shop', template: 'empty' })
    const moved = await ann.ok('POST', `/api/boards/${id}/tasks/A3/move`, { boardId: shop })
    expect(said((await commentsOf(ann, shop, moved.id))[0])).toBe('👀 Bob')
    // Deleted with it.
    await ann.ok('DELETE', `/api/boards/${shop}/comments/${comment.id}`)
    expect(await t.db.select().from(commentReactions)).toEqual([])
    expect(await bell(ann)).toEqual([])
  })
})
