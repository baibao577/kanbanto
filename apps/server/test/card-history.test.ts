import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CardHistory } from '@kanbanto/model/api'
import { newId } from '@kanbanto/model/ids'
import { eq } from 'drizzle-orm'
import { workSigns } from '../src/boards/activityLog'
import { boardActivity } from '../src/db/schema'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann owns the example board; Bob can edit it and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}
const run = (p: Person, board: string, command: object) => p.ok('POST', `/api/boards/${board}/mutations`, { mutationId: mid(), command })
const history = (p: Person, board: string, task: string, more = '') => p.ok<CardHistory>('GET', `/api/boards/${board}/tasks/${task}/activity${more}`)
/** The lines, oldest first, each after who did it. */
const said = (h: CardHistory) =>
  [...h.entries].reverse().flatMap((e) => e.lines.map((l) => `${e.actor?.name ?? 'Someone'} ${l.text}${l.date ? ` [${l.date}]` : ''}`))

describe('a card’s history', () => {
  it('says what was done to the card, by whom, in its own words, newest first, and nothing about other cards', async () => {
    const { ann, bob, id } = await team()
    await run(ann, id, { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'Call the venue', status: 'todo' } })
    await run(bob, id, { type: 'task.update', id: 'N1', fields: { status: 'doing' } })
    // One change, three things: they stay together.
    await run(bob, id, { type: 'task.update', id: 'N1', fields: { title: 'Call the venue again', assigneeId: ann.user.id, due: '2026-10-20' } })
    await run(ann, id, { type: 'task.update', id: 'N1', fields: { labels: ['brand'] } })
    // Something else on the board, and a change that touches this card and another at once.
    await run(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    await run(ann, id, {
      type: 'tasks.update',
      cards: [
        { id: 'N1', fields: { priority: 'high' } },
        { id: 'A3', fields: { priority: 'high' } },
      ],
    })
    await ann.request('POST', `/api/boards/${id}/tasks/N1/attachments`, Buffer.from('notes'), {
      'content-type': 'application/octet-stream',
      'x-file-name': 'notes.txt',
    })

    const h = await history(ann, id, 'N1')
    expect(said(h)).toEqual([
      'Ann added it',
      'Bob moved it from To Do to Doing',
      'Bob renamed it from “Call the venue” to “Call the venue again”',
      'Bob assigned it to Ann',
      'Bob set it due {date} [2026-10-20]',
      'Ann added the label “brand”',
      'Ann set the priority to High',
      'Ann attached “notes.txt”',
    ])
    // Newest first, the three things of one change in one entry, made on the website.
    expect(h.entries[0].lines[0].text).toBe('attached “notes.txt”')
    expect(h.entries.find((e) => e.lines.length === 3)?.actor).toMatchObject({ id: bob.user.id, name: 'Bob', picture: null })
    expect(h.entries.every((e) => e.via === null)).toBe(true)
    expect(h.nextUntil).toBeNull()
    // The other card has its own.
    expect(said(await history(ann, id, 'A3'))).toEqual(['Ann renamed it from “Deploy” to “Ship it”', 'Ann set the priority to High'])
    expect((await history(ann, id, 'nothing-here')).entries).toEqual([])
  })

  it('says what was done with the card’s logged time and its files, which aren’t board changes', async () => {
    const { ann, bob, id } = await team()
    const today = new Date().toISOString().slice(0, 10)
    // Time: logged for today and for another day, changed, then Bob's entry fixed and removed by the board's owner.
    const { entry } = await bob.ok('POST', `/api/boards/${id}/tasks/A3/time`, { minutes: 90, day: today })
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/time`, { minutes: 30, day: '2026-09-28', note: 'review' })
    await bob.ok('PATCH', `/api/boards/${id}/time/${entry.id}`, { minutes: 120 })
    // (A new note alone isn't said, nor the same time saved again.)
    await bob.ok('PATCH', `/api/boards/${id}/time/${entry.id}`, { note: 'pairing', minutes: 120 })
    await ann.ok('PATCH', `/api/boards/${id}/time/${entry.id}`, { minutes: 60 })
    await ann.ok('DELETE', `/api/boards/${id}/time/${entry.id}`)
    // Files: attached, removed, brought back. One saved for a comment that's never posted leaves no line.
    const file = (who: Person, name: string, more: Record<string, string> = {}) =>
      who.request<{ attachment: { id: string } }>('POST', `/api/boards/${id}/tasks/A3/attachments`, Buffer.from('notes'), {
        'content-type': 'application/octet-stream',
        'x-file-name': name,
        ...more,
      })
    const notes = (await file(ann, 'notes.txt')).body.attachment.id
    await bob.ok('DELETE', `/api/boards/${id}/attachments/${notes}`)
    await bob.ok('POST', `/api/boards/${id}/attachments/${notes}/restore`)
    const draft = (await file(bob, 'draft.txt', { 'x-attach-to': 'comment' })).body.attachment.id
    await bob.ok('DELETE', `/api/boards/${id}/attachments/${draft}`)

    expect(said(await history(ann, id, 'A3'))).toEqual([
      'Bob logged 1h 30m',
      'Bob logged 30m for {date} [2026-09-28]',
      'Bob changed the logged time from 1h 30m to 2h',
      'Ann changed Bob’s logged time from 2h to 1h',
      'Ann removed 1h of Bob’s logged time',
      'Ann attached “notes.txt”',
      'Bob removed “notes.txt”',
      'Bob restored “notes.txt”',
    ])
    // The board's log names the card.
    const log = await t.db.select().from(boardActivity).where(eq(boardActivity.boardId, id))
    const texts = log.flatMap((r) => (r.items as { text: string }[]).map((i) => i.text))
    expect(texts).toEqual(
      expect.arrayContaining([
        'logged 1h 30m on “Deploy”',
        'logged 30m on “Deploy” for 2026-09-28',
        'changed the time logged on “Deploy” from 1h 30m to 2h',
        'changed Bob’s time logged on “Deploy” from 2h to 1h',
        'removed 1h of Bob’s logged time from “Deploy”',
        'removed “notes.txt” from “Deploy”',
        'restored “notes.txt” to “Deploy”',
      ]),
    )
    // Typing in time isn't a sign the card was worked on just then: its day is (here, a day a week ago isn't in the last hour).
    await bob.ok('POST', `/api/boards/${id}/tasks/A1/time`, { minutes: 15, day: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10) })
    const signs = await workSigns(t.db, [id], new Date(Date.now() - 3_600_000), null, (m) => m.toISOString().slice(0, 10))
    expect(signs.has(`${id}:A1`)).toBe(false)
    // (A3 was changed in that hour: its files. The time still logged on it is for a day long before.)
    expect([...signs.get(`${id}:A3`)!]).toEqual(['changed'])
  })

  it('is for the board’s people: viewers read it, visitors with the public link and strangers don’t', async () => {
    const { ann, vic, id } = await team()
    await run(ann, id, { type: 'task.update', id: 'A3', fields: { status: 'doing' } })
    expect(said(await history(vic, id, 'A3'))).toEqual(['Ann moved it from To Do to Doing'])

    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const eve = await Person.signUp(t.app, 'Eve')
    expect((await eve.request('GET', `/api/boards/${id}/tasks/A3/activity`)).status).toBe(403)
    expect((await new Person(t.app).request('GET', `/api/boards/${id}/tasks/A3/activity`)).status).toBe(401)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: false })
    expect((await eve.request('GET', `/api/boards/${id}/tasks/A3/activity`)).status).toBe(404)
  })

  it('comes a page at a time, and says through which app a change was made', async () => {
    const { ann, id } = await team()
    for (const priority of ['low', 'medium', 'high', 'urgent', null]) await run(ann, id, { type: 'task.update', id: 'A3', fields: { priority } })
    const first = await history(ann, id, 'A3', '?limit=2')
    expect(said(first)).toEqual(['Ann set the priority to Urgent', 'Ann cleared the priority'])
    expect(first.nextUntil).toBe(first.entries[1].at)
    const second = await history(ann, id, 'A3', `?limit=2&until=${encodeURIComponent(first.nextUntil!)}`)
    expect(said(second)).toEqual(['Ann set the priority to Medium', 'Ann set the priority to High'])
    const last = await history(ann, id, 'A3', `?limit=2&until=${encodeURIComponent(second.nextUntil!)}`)
    expect(said(last)).toEqual(['Ann set the priority to Low'])
    expect(last.nextUntil).toBeNull()

    // With an API token: the entry says so.
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    const { token } = await ann.ok('POST', '/api/account/tokens', { name: 'script', scope: 'write', expiresInDays: null })
    const bearer = { authorization: `Bearer ${token}` }
    await new Person(t.app).request(
      'POST',
      `/api/boards/${id}/mutations`,
      { mutationId: mid(), command: { type: 'task.update', id: 'A3', fields: { status: 'done' } } },
      bearer,
    )
    const viaToken = await new Person(t.app).request<CardHistory>('GET', `/api/boards/${id}/tasks/A3/activity?limit=1`, undefined, bearer)
    expect(viaToken.body.entries[0]).toMatchObject({ via: 'API', lines: [{ text: 'moved it from To Do to Done' }] })
  })

  it('a line logged before the card’s own wording was kept is shown as it was written', async () => {
    const { ann, id } = await team()
    await t.db.insert(boardActivity).values({
      id: newId(),
      boardId: id,
      actorId: ann.user.id,
      command: 'task.update',
      items: [
        { taskId: 'A3', text: 'moved “Deploy” to Doing' },
        { taskId: 'A1', text: 'moved “Buy domain” to Doing' },
        { text: 'and made 3 more changes' },
      ],
      at: new Date(Date.now() - 86_400_000),
    })
    expect(said(await history(ann, id, 'A3'))).toEqual(['Ann moved “Deploy” to Doing'])
  })

  it('a card moved from another board starts where it arrived', async () => {
    const { ann, id } = await team()
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Other' })
    await run(ann, id, { type: 'task.update', id: 'A3', fields: { priority: 'high' } })
    const moved = await ann.ok('POST', `/api/boards/${id}/tasks/A3/move`, { boardId: other })
    await run(ann, other, { type: 'task.update', id: moved.id, fields: { priority: 'low' } })
    expect(said(await history(ann, other, moved.id))).toEqual(['Ann moved it here from another board', 'Ann set the priority to Low'])
    // (What happened before stays in the first board's log, under the id it had there.)
    expect(said(await history(ann, id, 'A3'))).toEqual(['Ann set the priority to High', 'Ann moved it to another board'])
  })
})
