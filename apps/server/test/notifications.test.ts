import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { notifications, users } from '../src/db/schema'
import { sendDigests } from '../src/mail/digest'
import { pruneNotifications } from '../src/routes/comments'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann owns a board; Bob (editor) is on it, and writes to her. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  const run = (p: Person, command: object) => p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
  const annId: string = (await ann.ok('GET', '/api/auth/me')).user.id
  /** A comment; one that says "@Ann" mentions her. */
  const says = (p: Person, taskId: string, body: string) =>
    p.ok('POST', `/api/boards/${id}/tasks/${taskId}/comments`, { body, ...(body.includes('@Ann') && { mentions: [annId] }) })
  return { ann, bob, id, run, says }
}
type Line = { id: string; kind: string; excerpt?: string; changes?: string[]; read: boolean; kept: boolean; task?: { id: string } }
type Page = { notifications: Line[]; unread: number; next: string | null }
const page = (p: Person, query = ''): Promise<Page> => p.ok('GET', `/api/notifications${query}`)
const said = (r: Page) => r.notifications.map((n) => n.excerpt ?? n.kind)

describe('the page of your notifications', () => {
  it('goes back through all of them, a page at a time, and is narrowed to the unread, to mentions, to a board', async () => {
    const { ann, bob, id, says } = await team()
    for (let i = 1; i <= 7; i++) await says(bob, 'A1', i % 3 ? `Note ${i}` : `@Ann look at ${i}`)
    // Newest first, as many as asked for, and where to go on from.
    const first = await page(ann, '?limit=3')
    expect(said(first)).toEqual(['Note 7', '@Ann look at 6', 'Note 5'])
    expect([first.unread, !!first.next]).toEqual([7, true])
    const second = await page(ann, `?limit=3&before=${encodeURIComponent(first.next!)}`)
    expect(said(second)).toEqual(['Note 4', '@Ann look at 3', 'Note 2'])
    const third = await page(ann, `?limit=3&before=${encodeURIComponent(second.next!)}`)
    expect([said(third), third.next]).toEqual([['Note 1'], null])
    // The bell asks for none of this, and gets the newest (30 at the most) as it always did.
    expect((await page(ann)).notifications).toHaveLength(7)

    // Only mentions; only the unread; only a board (one she isn't told about: nothing).
    expect(said(await page(ann, '?mentions=1'))).toEqual(['@Ann look at 6', '@Ann look at 3'])
    await ann.ok('POST', '/api/notifications/read', { ids: [first.notifications[0].id, second.notifications[0].id] })
    const unread = await page(ann, '?unread=1&limit=100')
    expect([said(unread), unread.unread]).toEqual([['@Ann look at 6', 'Note 5', '@Ann look at 3', 'Note 2', 'Note 1'], 5])
    expect(said(await page(ann, `?board=${id}&limit=2`))).toEqual(['Note 7', '@Ann look at 6'])
    expect(said(await page(ann, '?board=no-such-board'))).toEqual([])
    // What is asked for is checked.
    expect((await ann.request('GET', '/api/notifications?limit=1000')).status).toBe(400)
    expect((await ann.request('GET', '/api/notifications?before=yesterday')).status).toBe(400)
  })

  it('a line is turned back to unread to come back to, and stays the person’s own until they deal with it', async () => {
    const { ann, bob, run, says } = await team()
    // (The site sends email, and Ann gets the morning summary.)
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await t.db.update(users).set({ emailVerifiedAt: new Date() })
    // (Ann follows a card by commenting on it.)
    await says(ann, 'A1', 'Mine to follow.')
    await run(bob, { type: 'task.update', id: 'A1', fields: { description: 'First draft.' } })
    await says(bob, 'A2', '@Ann the tiles are late')
    const lines = async () => (await page(ann)).notifications.map((n) => [n.excerpt ?? n.kind, n.read, n.kept])
    expect(await lines()).toEqual([
      ['@Ann the tiles are late', false, false],
      ['change', false, false],
    ])
    expect((await page(ann)).notifications[1].changes).toHaveLength(1)
    const [mention, change] = (await page(ann)).notifications

    // Read, then turned back: unread again, counted again, and marked as kept.
    await ann.ok('POST', '/api/notifications/read', {})
    expect((await page(ann)).unread).toBe(0)
    await ann.ok('PUT', `/api/notifications/${change.id}/read`, { read: false })
    expect([await lines(), (await page(ann)).unread]).toEqual([
      [
        ['@Ann the tiles are late', true, false],
        ['change', false, true],
      ],
      1,
    ])

    // Nothing more is added to it: the next change to that card, by the same person, is a line of its own.
    await run(bob, { type: 'task.update', id: 'A1', fields: { description: 'Second draft.' } })
    expect(await lines()).toEqual([
      ['change', false, false],
      ['@Ann the tiles are late', true, false],
      ['change', false, true],
    ])
    // (The kept line says what it said, and no more.)
    expect((await page(ann)).notifications.map((n) => n.changes?.length)).toEqual([1, undefined, 1])

    // The morning summary tells her of what is new, and leaves out the line she kept: she knows about that one.
    expect(await sendDigests(t.app, new Date('2026-10-01T08:05:00Z'))).toBe(1)
    const mailed = await t.db.select({ id: notifications.id, at: notifications.emailedAt }).from(notifications)
    expect(mailed.filter((m) => m.at).map((m) => m.id)).toEqual([(await page(ann)).notifications[0].id])

    // "Mark all as read" marks what is new, and leaves the one she kept.
    await ann.ok('POST', '/api/notifications/read', {})
    expect([(await lines()).map((l) => l.slice(1)), (await page(ann)).unread]).toEqual([
      [
        [true, false],
        [true, false],
        [false, true],
      ],
      1,
    ])
    expect(said(await page(ann, '?unread=1'))).toEqual(['change'])

    // Opened (marked read by name), or marked read, it is an ordinary read line again.
    await ann.ok('PUT', `/api/notifications/${change.id}/read`, { read: true })
    expect([(await page(ann)).unread, (await lines())[2].slice(1)]).toEqual([0, [true, false]])
    await ann.ok('PUT', `/api/notifications/${mention.id}/read`, { read: false })
    await ann.ok('POST', '/api/notifications/read', { ids: [mention.id] })
    expect((await page(ann)).unread).toBe(0)

    // Only one's own lines, and only ones that are there.
    expect((await bob.request('PUT', `/api/notifications/${mention.id}/read`, { read: false })).status).toBe(404)
    expect((await ann.request('PUT', '/api/notifications/01a11f00-0000-7000-8000-000000000000/read', { read: false })).status).toBe(404)
    expect((await ann.request('PUT', '/api/notifications/not-an-id/read', { read: false })).status).toBe(400)
    expect((await page(ann)).unread).toBe(0)
  })

  it('read lines go three months after they came; unread ones stay, however old', async () => {
    const { ann, bob, says } = await team()
    for (const words of ['old and read', 'old and new', 'old and kept', 'fresh and read']) await says(bob, 'A1', `@Ann ${words}`)
    const all = (await page(ann)).notifications
    const id = (words: string) => all.find((n) => n.excerpt === `@Ann ${words}`)!.id
    await ann.ok('POST', '/api/notifications/read', { ids: [id('old and read'), id('old and kept'), id('fresh and read')] })
    await ann.ok('PUT', `/api/notifications/${id('old and kept')}/read`, { read: false })
    // (Four months ago, and one day short of three.)
    for (const words of ['old and read', 'old and new', 'old and kept'])
      await t.db
        .update(notifications)
        .set({ createdAt: sql`now() - interval '4 months'` })
        .where(eq(notifications.id, id(words)))
    await t.db
      .update(notifications)
      .set({ createdAt: sql`now() - interval '3 months' + interval '1 day'` })
      .where(eq(notifications.id, id('fresh and read')))
    await pruneNotifications(t.db)
    expect(said(await page(ann)).sort()).toEqual(['@Ann fresh and read', '@Ann old and kept', '@Ann old and new'])
  })
})
