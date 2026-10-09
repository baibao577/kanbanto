import type { CommentView, NotificationView } from '@kanbanto/model/api'
import { exportFile, type BoardExtras } from '@kanbanto/model/transfer'
import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { webhookDeliveries } from '../src/db/schema'
import type { LiveMessage } from '../src/live'
import { sendDigests } from '../src/mail/digest'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const TEXT = `## What we recommend

Renew the session when the page comes back into view. **Keep sessions for 30 days**, and ask for the password again
only before an email or a password is changed.

| Who | How long |
|---|---|
| Admins | 14 days |
| Everyone else | 30 days |`
const ABOUT = { quote: 'Keep sessions for 30 days', before: 'comes back into view.', after: ', and ask for the password' }

type Answer = { comment: CommentView; error?: string }
const post = (p: Person, board: string, body: object, task = 'A3') => p.request<Answer>('POST', `/api/boards/${board}/tasks/${task}/comments`, body)
const resolve = (p: Person, board: string, comment: string, resolved = true) =>
  p.request<Answer>('PUT', `/api/boards/${board}/comments/${comment}/resolved`, { resolved })
const commentsOf = async (p: Person, board: string, task = 'A3') =>
  (await p.ok<{ comments: CommentView[] }>('GET', `/api/boards/${board}/tasks/${task}/comments`)).comments
const bell = async (p: Person): Promise<NotificationView[]> =>
  (await p.ok('GET', '/api/notifications')).notifications.filter((n: { kind: string }) => n.kind !== 'added')
/** A person's bell in a few words: "comment by Bob about “…”". */
const lines = async (p: Person) =>
  (await bell(p)).map(
    (n) => `${n.kind} by ${n.actor}${'about' in n && n.about ? ` about “${n.about}”` : ''}${'excerpt' in n ? `: ${n.excerpt}` : ''}`,
  )

/** Ann owns the example board, whose card Deploy (A3) has a description; Bob can edit the board and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  await ann.ok('POST', `/api/boards/${id}/mutations`, {
    mutationId: mid(),
    command: { type: 'task.update', id: 'A3', fields: { description: TEXT } },
  })
  await Promise.all([ann, bob, vic].map((p) => p.ok('POST', '/api/notifications/read', {})))
  return { ann, bob, vic, id }
}

async function listen(p: Person, boardId: string) {
  const messages: LiveMessage[] = []
  const ws: WebSocket = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers: p.cookie ? { cookie: p.cookie } : {} })
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20))
    return test()
  }
  return { ws, messages, until }
}

describe('a comment about some words of a description', () => {
  it('keeps the words, is answered in a thread, and is anyone’s who can comment', async () => {
    const { ann, bob, vic, id } = await team()
    // Vic can only look at the board: he can comment, so he can comment on a passage.
    const first = await post(vic, id, {
      body: 'Is 30 days what Legal agreed? I remember 14.',
      passage: { ...ABOUT, quote: '  Keep sessions\nfor 30 days ' },
    })
    expect(first.status).toBe(200)
    expect(first.body.comment).toMatchObject({ passage: ABOUT, resolved: null })
    expect(first.body.comment.parentId).toBeUndefined()
    const root = first.body.comment.id
    // Answers gather under it: an answer to an answer is in the same thread, and has no words of its own.
    const one = (await post(ann, id, { body: '14 was for admins. I added a line.', parentId: root })).body.comment
    const two = (await post(bob, id, { body: 'Good.', parentId: one.id, passage: { quote: 'Admins' } })).body.comment
    expect([one.parentId, two.parentId, two.passage]).toEqual([root, root, undefined])
    // An ordinary comment is as it was, and isn't answered this way.
    const plain = (await post(bob, id, { body: 'Shipped.' })).body.comment
    expect([plain.passage, plain.parentId, plain.resolved]).toEqual([undefined, undefined, undefined])
    const no = await post(ann, id, { body: 'Reply', parentId: plain.id })
    expect([no.status, no.body.error]).toEqual([400, 'Only a comment about words of the description can be answered.'])
    // Nor one on another card, or one that is gone.
    expect((await post(ann, id, { body: 'x', parentId: root }, 'A1')).status).toBe(404)
    expect((await post(ann, id, { body: 'x', parentId: '01900000-0000-7000-8000-000000000000' })).status).toBe(404)
    expect((await post(ann, id, { body: 'x', passage: { quote: '   ' } })).status).toBe(400)
    // Everyone who can open the board reads them; a visitor with the public link can't write one.
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const visitor = new Person(t.app)
    expect((await commentsOf(visitor, id)).map((c) => c.body)).toHaveLength(4)
    expect((await post(visitor, id, { body: 'Hi', passage: ABOUT })).status).toBe(401)
  })

  it('is resolved and opened again by anyone who can comment, and an answer opens it again', async () => {
    const { ann, bob, vic, id } = await team()
    const live = await listen(ann, id)
    const root = (await post(bob, id, { body: 'Is 30 days right?', passage: ABOUT })).body.comment
    const done = await resolve(vic, id, root.id)
    expect(done.status).toBe(200)
    expect(done.body.comment.resolved).toMatchObject({ by: { id: vic.user.id, name: 'Vic' } })
    expect(Date.parse(done.body.comment.resolved!.at)).toBeGreaterThan(Date.now() - 5000)
    // Everyone with the board open sees it at once.
    expect(await live.until(() => live.messages.some((m) => m.type === 'comment' && m.action === 'resolved'))).toBe(true)
    // Its author has one line under the bell for it, however often it is done; none for resolving their own.
    await resolve(vic, id, root.id)
    expect(await lines(bob)).toEqual(['resolved by Vic about “Keep sessions for 30 days”: Is 30 days right?'])
    // Opened again: the line has nothing left to say.
    expect((await resolve(ann, id, root.id, false)).body.comment.resolved).toBeNull()
    expect(await lines(bob)).toEqual([])
    await resolve(bob, id, root.id)
    expect(await lines(bob)).toEqual([])
    // An answer to a settled thread opens it again.
    await post(ann, id, { body: 'One more thing.', parentId: root.id })
    expect((await commentsOf(ann, id)).find((c) => c.id === root.id)!.resolved).toBeNull()
    // Only a comment about a passage is resolved; not its answers, not an ordinary comment, not by a visitor.
    const answer = (await commentsOf(ann, id)).find((c) => c.parentId)!
    expect((await resolve(ann, id, answer.id)).status).toBe(400)
    const plain = (await post(ann, id, { body: 'Plain.' })).body.comment
    expect((await resolve(ann, id, plain.id)).status).toBe(400)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    expect((await resolve(new Person(t.app), id, root.id)).status).toBe(401)
    live.ws.terminate()
  })

  it('tells the same people as any comment, with the words it is about', async () => {
    const { ann, bob, vic, id } = await team()
    // Bob comments on a passage and mentions Ann: she is told as mentioned, with the words.
    const root = (await post(bob, id, { body: '@Ann is 30 days right?', mentions: [ann.user.id], passage: ABOUT })).body.comment
    expect(await lines(ann)).toEqual(['mention by Bob about “Keep sessions for 30 days”: @Ann is 30 days right?'])
    // (The line says which thread it is, so that it can open the description at those words.)
    expect((await bell(ann))[0]).toMatchObject({ thread: root.id })
    // Ann answers: Bob follows the card (he commented), and hears of it, with the words the thread is about.
    await post(ann, id, { body: 'It is.', parentId: root.id })
    expect(await lines(bob)).toEqual(['comment by Ann about “Keep sessions for 30 days”: It is.'])
    expect((await bell(bob))[0]).toMatchObject({ thread: root.id })
    // An ordinary comment says no words.
    await post(ann, id, { body: 'Unrelated.' })
    expect((await lines(bob))[0]).toBe('comment by Ann: Unrelated.')
    // The morning email takes them like any comment (a resolved thread isn't news for it).
    await resolve(vic, id, root.id)
    expect((await lines(bob)).filter((l) => l.startsWith('resolved'))).toHaveLength(1)
    await sendDigests(t.app, new Date(Date.now() + 86_400_000))
    expect(await lines(bob)).toHaveLength(3)
  })

  it('goes with its answers when it is deleted, and moves with its card to another board', async () => {
    const { ann, bob, id } = await team()
    const live = await listen(bob, id)
    const root = (await post(bob, id, { body: 'Is 30 days right?', passage: ABOUT })).body.comment
    const a1 = (await post(ann, id, { body: 'Yes.', parentId: root.id })).body.comment
    const a2 = (await post(bob, id, { body: 'Thanks.', parentId: root.id })).body.comment
    // To another board: the thread is as it was.
    const other = await ann.ok<{ id: string }>('POST', '/api/boards', { name: 'Elsewhere', template: 'empty' })
    const moved = await ann.ok<{ id: string }>('POST', `/api/boards/${id}/tasks/A3/move`, { boardId: other.id })
    const there = await commentsOf(ann, other.id, moved.id)
    expect(there.map((c) => [c.body, c.parentId ?? null, !!c.passage])).toEqual([
      ['Is 30 days right?', null, true],
      ['Yes.', root.id, false],
      ['Thanks.', root.id, false],
    ])
    // Deleted: its answers go with it, and each is said to be gone.
    const back = await ann.ok<{ id: string }>('POST', `/api/boards/${other.id}/tasks/${moved.id}/move`, { boardId: id })
    live.messages.length = 0
    expect((await bob.request('DELETE', `/api/boards/${id}/comments/${root.id}`)).status).toBe(200)
    expect(await commentsOf(ann, id, back.id)).toEqual([])
    expect(await live.until(() => live.messages.filter((m) => m.type === 'comment' && m.action === 'deleted').length === 3)).toBe(true)
    expect(live.messages.flatMap((m) => (m.type === 'comment' ? [m.commentId] : [])).sort()).toEqual([root.id, a1.id, a2.id].sort())
    live.ws.terminate()
  })

  it('is in the board’s file with its answers, and comes back with them', async () => {
    const { ann, bob, id } = await team()
    const root = (await post(bob, id, { body: 'Is 30 days right?', passage: ABOUT })).body.comment
    await post(ann, id, { body: 'Yes.', parentId: root.id })
    await resolve(ann, id, root.id)
    await post(ann, id, { body: 'A plain one.' })
    const extras = (await ann.ok<BoardExtras>('GET', `/api/boards/${id}/extras`)).comments.filter((c) => c.taskId === 'A3')
    expect(extras.map((c) => [c.body, !!c.passage, c.resolved ?? false, c.replyTo ? 'answer' : ''])).toEqual([
      ['Is 30 days right?', true, true, ''],
      ['Yes.', false, false, 'answer'],
      ['A plain one.', false, false, ''],
    ])
    expect(extras[1].replyTo).toBe(extras[0].id)
    const whole = (await ann.ok('GET', `/api/boards/${id}?archived=all`)).data
    const file = JSON.parse(JSON.stringify(exportFile(whole, await ann.ok<BoardExtras>('GET', `/api/boards/${id}/extras`))))
    // An answer whose comment isn't in the file comes as a comment of its own.
    file.comments.push({ taskId: 'A3', by: null, body: 'Answer to nothing.', at: new Date().toISOString(), replyTo: 'gone' })
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file })
    const back = await commentsOf(ann, made.id)
    const thread = back.find((c) => c.passage)!
    expect(thread).toMatchObject({ body: '**Bob** wrote:\n\nIs 30 days right?', passage: ABOUT })
    expect(thread.resolved).not.toBeNull()
    expect(back.map((c) => [c.body, c.parentId === thread.id])).toEqual([
      ['**Bob** wrote:\n\nIs 30 days right?', false],
      ['Yes.', true],
      ['A plain one.', false],
      ['Someone wrote:\n\nAnswer to nothing.', false],
    ])
  })

  it('goes to webhooks with its words, and assistants read it, quote words and answer', async () => {
    const { ann, bob, id } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true, webhooks: 'any' })
    await ann.ok('POST', `/api/boards/${id}/webhooks`, { url: 'http://127.0.0.1:9/hook', events: ['comment.added'] })
    const root = (await post(bob, id, { body: 'Is 30 days right?', passage: ABOUT })).body.comment
    await post(ann, id, { body: 'Yes.', parentId: root.id })
    await t.app.webhooks.queued()
    const sent = (await t.db.select().from(webhookDeliveries)).map(
      (d) => (d.payload as { comment: { body: string; about?: string; replyTo?: string } }).comment,
    )
    expect(sent.map((c) => [c.body, c.about, c.replyTo ?? null]).sort()).toEqual(
      [
        ['Is 30 days right?', 'Keep sessions for 30 days', null],
        ['Yes.', 'Keep sessions for 30 days', root.id],
      ].sort(),
    )

    // An assistant, as Ann.
    const token = (await ann.ok('POST', '/api/account/tokens', { name: 'script', scope: 'write', expiresInDays: null })).token as string
    const call = (method: string, params: object) =>
      new Person(t.app).request(
        'POST',
        '/api/mcp',
        { jsonrpc: '2.0', id: 1, method, params },
        { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      )
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const tool = async (name: string, args: object) => {
      const r = await call('tools/call', { name, arguments: args })
      return { ...JSON.parse(r.body.result.content[0].text), isError: !!r.body.result.isError }
    }
    const task = await tool('get_task', { board_id: id, task_id: 'A3' })
    expect(task.comments.map((c: { text: string; about?: string; reply_to?: string }) => [c.text, c.about ?? null, c.reply_to ?? null])).toEqual([
      ['Is 30 days right?', 'Keep sessions for 30 days', null],
      ['Yes.', null, root.id],
    ])
    // It quotes words of the description to comment on them: found as the text reads, with what stands around them.
    const made = await tool('add_comment', { board_id: id, task_id: 'A3', text: 'Admins get less.', about: 'Admins 14 days' })
    expect(made.isError).toBe(false)
    const theirs = (await commentsOf(ann, id)).find((c) => c.id === made.comment_id)!
    expect(theirs.passage).toMatchObject({ quote: 'Admins 14 days' })
    expect(theirs.passage!.before.endsWith('Howlong')).toBe(true)
    // Words that aren't there are refused, with what to do.
    const wrong = await tool('add_comment', { board_id: id, task_id: 'A3', text: 'x', about: 'Keep sessions for 90 days' })
    expect([wrong.isError, /aren’t in the task’s description/.test(JSON.stringify(wrong))]).toEqual([true, true])
    // It answers a thread, and reads what is settled and what the text no longer says.
    await tool('add_comment', { board_id: id, task_id: 'A3', text: 'Noted.', reply_to: root.id })
    await resolve(bob, id, made.comment_id)
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A3', fields: { description: TEXT.replace('for 30 days**', 'for 60 days**') } },
    })
    const after = (await tool('get_task', { board_id: id, task_id: 'A3' })).comments as {
      text: string
      resolved?: boolean
      words_changed_since?: boolean
      reply_to?: string
    }[]
    expect(after.map((c) => [c.text, !!c.resolved, !!c.words_changed_since, !!c.reply_to])).toEqual([
      ['Is 30 days right?', false, true, false],
      ['Yes.', false, false, true],
      ['Admins get less.', true, false, false],
      ['Noted.', false, false, true],
    ])
  })
})
