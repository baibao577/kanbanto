import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { users } from '../src/db/schema'
import { mentionedIn } from '../src/boards/follows'
import { sendDigests } from '../src/mail/digest'
import { flushMail, mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann owns a board; Bob (editor) and Vic (viewer) are on it. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  const run = (p: Person, command: object) => p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
  return { ann, bob, vic, id, run }
}

type Line = { kind: string; actor: string; where?: string; excerpt?: string; changes?: string[]; task?: { id: string }; read: boolean }
/** What's under someone's bell, newest first, without "added you to the board". */
const bell = async (p: Person): Promise<Line[]> => (await p.ok('GET', '/api/notifications')).notifications.filter((n: Line) => n.kind !== 'added')
const following = async (p: Person, id: string, taskId: string) => (await p.ok('GET', `/api/boards/${id}/tasks/${taskId}/follow`)).following

describe('@mentions in a description', () => {
  it('finds names whole, longest first, in any case', () => {
    const people = [
      { id: 'a', name: 'Ann' },
      { id: 'al', name: 'Ann Lee' },
      { id: 'b', name: 'Bob' },
    ]
    expect(mentionedIn('ask @ann, then @BOB.', people).sort()).toEqual(['a', 'b'])
    expect(mentionedIn('ask @Ann Lee', people)).toEqual(['al'])
    expect(mentionedIn('ask @Anna and bob@example.com', people)).toEqual([])
    expect(mentionedIn(undefined, people)).toEqual([])
  })

  it('tells the people newly mentioned, once, and never the person writing', async () => {
    const { ann, bob, vic, id, run } = await team()
    await run(bob, { type: 'task.update', id: 'A3', fields: { description: 'Steps\n\nPlease check this @Ann, with @Bob.' } })
    expect(await bell(ann)).toMatchObject([
      { kind: 'mention', where: 'description', actor: 'Bob', task: { id: 'A3' }, excerpt: 'Please check this @Ann, with @Bob.' },
    ])
    expect(await bell(bob)).toEqual([])
    // Being mentioned is following the card from then on.
    expect(await following(ann, id, 'A3')).toBe(true)

    // More writing: Ann isn't told again (not as a mention, and not as a follower who was just mentioned). Vic, new, is.
    await ann.ok('POST', '/api/notifications/read', {})
    await run(bob, { type: 'task.update', id: 'A3', fields: { description: 'Steps\n\nPlease check this @Ann, with @Bob. And @vic too.' } })
    expect((await bell(vic)).map((n) => n.kind)).toEqual(['mention'])
    expect((await bell(ann)).map((n) => [n.kind, n.read])).toEqual([
      ['change', false],
      ['mention', true],
    ])
    expect((await bell(ann))[0].changes).toEqual(['edited the description of “Deploy”'])

    // A new card that already mentions someone tells them too.
    await run(bob, { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'Fresh', description: 'for @Ann' } })
    expect((await bell(ann))[0]).toMatchObject({ kind: 'mention', where: 'description', task: { id: 'N1' } })
  })

  it('says nothing when undo puts a mention back', async () => {
    const { ann, bob, vic, id, run } = await team()
    await run(bob, { type: 'task.update', id: 'A3', fields: { description: 'for @Vic' } })
    const withMention = (await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A3
    await run(bob, { type: 'task.update', id: 'A3', fields: { description: 'for nobody' } })
    const without = (await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A3
    await run(bob, { type: 'records.restore', changes: [{ entity: 'task', id: 'A3', before: without, after: withMention }] })
    expect((await ann.ok('GET', `/api/boards/${id}`)).data.tasks.A3.description).toBe('for @Vic')
    expect((await bell(vic)).filter((n) => n.kind === 'mention')).toHaveLength(1)
  })
})

describe('following a card', () => {
  it('starts when you make a card, are given it, comment or are mentioned; and you can stop', async () => {
    const { ann, bob, vic, id, run } = await team()
    await run(bob, { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'Fresh' } })
    expect(await following(bob, id, 'N1')).toBe(true)
    expect(await following(ann, id, 'N1')).toBe(false)

    // Given to Ann: she follows it, and is told so.
    await run(bob, { type: 'task.update', id: 'N1', fields: { assigneeId: ann.user.id } })
    expect(await following(ann, id, 'N1')).toBe(true)
    expect(await bell(ann)).toMatchObject([{ kind: 'change', actor: 'Bob', task: { id: 'N1' }, changes: ['assigned “Fresh” to you'] }])

    // A viewer can comment, and follows from then on. Ann and Bob hear of the comment; Vic doesn't hear of his own.
    await vic.ok('POST', `/api/boards/${id}/tasks/N1/comments`, { body: 'Looks good' })
    expect(await following(vic, id, 'N1')).toBe(true)
    expect((await bell(ann))[0]).toMatchObject({ kind: 'comment', actor: 'Vic', excerpt: 'Looks good' })
    expect((await bell(bob))[0]).toMatchObject({ kind: 'comment', actor: 'Vic' })
    expect(await bell(vic)).toEqual([])

    // A comment that mentions you is a mention, not also a comment.
    await bob.ok('POST', `/api/boards/${id}/tasks/N1/comments`, { body: '@Ann ok?', mentions: [ann.user.id] })
    expect((await bell(ann)).map((n) => n.kind)).toEqual(['mention', 'comment', 'change'])
    expect((await bell(vic)).map((n) => n.kind)).toEqual(['comment'])

    // Ann stops: comments (hers too) don't start it again, a new assignment does.
    expect(await ann.ok('PUT', `/api/boards/${id}/tasks/N1/follow`, { following: false })).toEqual({ following: false })
    await vic.ok('POST', `/api/boards/${id}/tasks/N1/comments`, { body: 'Again' })
    await ann.ok('POST', `/api/boards/${id}/tasks/N1/comments`, { body: 'Mine' })
    expect(await following(ann, id, 'N1')).toBe(false)
    expect((await bell(ann)).filter((n) => n.task?.id === 'N1')).toHaveLength(3)
    await run(bob, { type: 'task.update', id: 'N1', fields: { assigneeId: bob.user.id } })
    await run(bob, { type: 'task.update', id: 'N1', fields: { assigneeId: ann.user.id } })
    expect(await following(ann, id, 'N1')).toBe(true)

    // A card that's yours is one you follow, even if nothing ever said so (the ones a new board comes with).
    expect(await following(ann, id, 'A1')).toBe(true)
    expect(await following(bob, id, 'A1')).toBe(false)
    await run(bob, { type: 'task.update', id: 'A1', fields: { due: '2026-10-20' } })
    expect((await bell(ann))[0]).toMatchObject({ kind: 'change', task: { id: 'A1' }, changes: ['set “Buy domain” due 20 Oct'] })
    await ann.ok('PUT', `/api/boards/${id}/tasks/A1/follow`, { following: false })
    expect(await following(ann, id, 'A1')).toBe(false)

    // Searching for the cards you follow: N1 is Ann's again (and so followed), A1 she stopped, though it's hers.
    const followed = async (p: Person) =>
      (await p.ok('GET', `/api/cards?state=active&following=true&board=${id}`)).cards.map((c: { id: string }) => c.id) as string[]
    expect(await followed(ann)).toContain('N1')
    expect(await followed(ann)).not.toContain('A1')
    expect(await followed(vic)).toEqual(['N1'])

    // Not for someone who isn't on the board, or a card that isn't there.
    const stranger = await Person.signUp(t.app, 'Sue')
    expect((await stranger.request('PUT', `/api/boards/${id}/tasks/N1/follow`, { following: true })).status).toBeGreaterThanOrEqual(403)
    expect((await ann.request('PUT', `/api/boards/${id}/tasks/nope/follow`, { following: true })).status).toBe(404)
  })

  it('tells followers what happened to the card, a few changes at a time, and not what they did themselves', async () => {
    const { ann, bob, vic, id, run } = await team()
    await ann.ok('PUT', `/api/boards/${id}/tasks/A3/follow`, { following: true })
    await vic.ok('PUT', `/api/boards/${id}/tasks/A3/follow`, { following: true })
    const { data } = await ann.ok('GET', `/api/boards/${id}`)
    const done = data.columns.find((c: { category: string }) => c.category === 'done')

    await run(bob, { type: 'task.update', id: 'A3', fields: { status: done.id } })
    await run(bob, { type: 'task.update', id: 'A3', fields: { due: '2026-10-15', priority: 'high', labels: [] } })
    await run(bob, { type: 'task.update', id: 'A3', fields: { assigneeId: vic.user.id } })
    // One line for the three, in order; the priority isn't news. Vic reads "to you".
    expect(await bell(ann)).toMatchObject([
      { kind: 'change', actor: 'Bob', changes: [`moved “Deploy” to ${done.name}`, 'set “Deploy” due 15 Oct', 'assigned “Deploy” to Vic'] },
    ])
    expect((await bell(vic))[0].changes?.at(-1)).toBe('assigned “Deploy” to you')
    expect(await bell(bob)).toEqual([])

    // Once read, what comes next is a new line. Ann's own change tells Vic, not Ann.
    await ann.ok('POST', '/api/notifications/read', {})
    await run(ann, { type: 'task.update', id: 'A3', fields: { due: '' } })
    expect(await bell(ann)).toHaveLength(1)
    expect((await bell(vic))[0]).toMatchObject({ actor: 'Ann', changes: ['cleared the due date of “Deploy”'] })

    // Archived, then deleted for good: followers hear of both.
    await run(bob, { type: 'task.archive', id: 'A3' })
    await run(bob, { type: 'task.delete', id: 'A3' })
    expect((await bell(ann))[0].changes).toEqual(['archived “Deploy” as completed', 'deleted “Deploy”'])
  })

  it('reaches the morning email and the desktop, for people who want that', async () => {
    const { ann, bob, id, run } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await t.db.update(users).set({ emailVerifiedAt: new Date() })
    const sent: { title: string; body: string; url: string }[] = []
    t.app.push.transport = async (_sub, payload) => void sent.push(JSON.parse(payload))
    await ann.ok('POST', '/api/push/devices', { endpoint: 'https://push.example.com/ann-1', keys: { p256dh: 'BPk', auth: 'aa' }, label: 'Chrome' })
    await ann.ok('PUT', `/api/boards/${id}/tasks/A3/follow`, { following: true })

    await run(bob, { type: 'task.update', id: 'A3', fields: { due: '2026-10-15' } })
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'Ready when you are' })
    await run(bob, { type: 'task.update', id: 'A3', fields: { description: 'See @Ann' } })
    await new Promise((r) => setTimeout(r, 150))
    expect(sent.map((s) => s.title).sort()).toEqual(['Bob commented on “Deploy”', 'Bob mentioned you', 'Bob set “Deploy” due 15 Oct'])
    expect(sent[0].url).toBe(`/#/b/${id}?task=A3`)

    // Switched off: nothing more on the desktop; the bell still has it.
    await ann.ok('PATCH', '/api/auth/me', { pushFollows: false })
    await bob.ok('POST', `/api/boards/${id}/tasks/A3/comments`, { body: 'Still there?' })
    await new Promise((r) => setTimeout(r, 150))
    expect(sent).toHaveLength(3)
    expect((await bell(ann))[0]).toMatchObject({ kind: 'comment', excerpt: 'Still there?' })

    expect(await sendDigests(t.app, new Date('2026-10-01T08:05:00Z'))).toBe(1)
    await flushMail(t.app)
    const email = t.mail.last('ann@example.com')!
    expect(email.subject).toBe('Your day, Thu 1 Oct: 1 mention, 3 updates')
    expect(email.text).toContain('On cards you follow')
    expect(email.text).toContain('Bob set “Deploy” due 15 Oct')
    expect(email.text).toContain('Bob: “Ready when you are”')
    expect(email.text).toContain('Bob: “See @Ann”')
  })
})
