import { invertChanges } from '@kanbanto/model/changes'
import type { NotificationView } from '@kanbanto/model/api'
import type { Change } from '@kanbanto/model/records'
import { ASSIGNEE, tellOn, type BoardRule, type WhenRule } from '@kanbanto/model/rules'
import { exportFile } from '@kanbanto/model/transfer'
import type { BoardData } from '@kanbanto/model/types'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardActivity, boardRuleMutes, users } from '../src/db/schema'
import { sendDigests } from '../src/mail/digest'
import { flushMail, mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

type Snapshot = { data: BoardData; seq: number }
type Said = NotificationView & { kind: 'rule' }
const load = (p: Person, id: string) => p.ok<Snapshot>('GET', `/api/boards/${id}`)
const run = (p: Person, id: string, command: object) =>
  p.ok<{ changes: Change[] }>('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const make = (p: Person, board: string, rule: object) =>
  p.request<{ rule: BoardRule; error?: string }>('POST', `/api/boards/${board}/rules`, { rule })
/** A rule as the app sends it (no id): tell these people when a card arrives in a list, or (`on`) leaves it. */
const tell = (who: string[], list = 'doing', over: Partial<WhenRule> = {}) => {
  const { id: _id, ...rule } = { ...tellOn('', list, 'derived'), then: [{ do: 'tell' as const, who }], ...over }
  return rule
}
/** What someone's bell holds, newest first: what rules told them, and (`all`) the rest too, but for "added you". */
const bell = async (p: Person) => (await p.ok('GET', '/api/notifications')).notifications.filter((n: { kind: string }) => n.kind !== 'added')
const told = async (p: Person): Promise<Said[]> => (await bell(p)).filter((n: { kind: string }) => n.kind === 'rule')
/** In a few words: "Bob: Deploy, Book a photographer arrived in Doing". */
const lines = async (p: Person) =>
  (await told(p)).map((n) => `${n.actor}: ${n.cards.map((c) => c.title).join(', ')}${n.more ? ` +${n.more}` : ''} ${n.moment}`)
const move = (p: Person, id: string, card: string, list: string) => run(p, id, { type: 'task.update', id: card, fields: { status: list } })

/**
 * Ann owns the example board (Deploy, A3, is hers, in To Do; Homepage, A2a, and Send invites, B1, are nobody's, in
 * Doing); Bob can edit it and Vic can only look.
 */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  const rule = async (r: object) => {
    const made = await make(ann, id, r)
    expect(made.status).toBe(200)
    return made.body.rule
  }
  return { ann, bob, vic, id, rule }
}

describe('a rule that tells people', () => {
  it('tells the people it names when a card arrives, and never the one who moved it', async () => {
    const { ann, bob, vic, id, rule } = await team()
    const made = await rule(tell([ann.user.id, bob.user.id], 'doing', { name: 'Started' }))
    expect(made).toMatchObject({
      kind: 'when',
      on: 'enters',
      cards: { statuses: ['doing'] },
      then: [{ do: 'tell', who: [ann.user.id, bob.user.id] }],
    })
    // It comes with the board, like a limit, for everyone who can open it.
    for (const p of [ann, bob, vic]) expect((await load(p, id)).data.rules).toEqual([made])

    await move(bob, id, 'A3', 'doing')
    expect(await told(ann)).toMatchObject([
      {
        kind: 'rule',
        actor: 'Bob',
        board: { id },
        task: { id: 'A3', title: 'Deploy' },
        rule: { id: made.id, name: 'Started' },
        moment: 'arrived in Doing',
        cards: [{ id: 'A3', title: 'Deploy' }],
        more: 0,
        read: false,
      },
    ])
    expect(await told(bob)).toEqual([])
    expect(await told(vic)).toEqual([])
    // Ann's own move tells Bob, not Ann. A change that leaves a card where it is tells nobody.
    await move(ann, id, 'B2', 'doing')
    await run(ann, id, { type: 'task.update', id: 'B2', fields: { title: 'Book the photographer' } })
    expect(await lines(bob)).toEqual(['Ann: Book a photographer arrived in Doing'])
    expect(await told(ann)).toHaveLength(1)
    // A card made there, archived out of it and brought back: made and brought back are arrivals.
    await run(bob, id, { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'Fix the footer', status: 'doing' } })
    await run(bob, id, { type: 'task.archive', id: 'N1' })
    await ann.ok('POST', '/api/notifications/read', {})
    await run(bob, id, { type: 'task.restore', id: 'N1' })
    expect(await lines(ann)).toEqual(['Bob: Fix the footer arrived in Doing', 'Bob: Deploy, Fix the footer arrived in Doing'])
    // The log says who made the rule, in its own words.
    const log = await t.db.select().from(boardActivity).where(eq(boardActivity.command, 'board.rules'))
    expect(log.map((l) => (l.items as { text: string }[])[0].text)).toEqual(['added a rule: When a card arrives in Doing, tell Ann and Bob'])
  })

  it('is its board’s owners’ to make, about people who are on the board', async () => {
    const { ann, bob, vic, id } = await team()
    expect((await make(bob, id, tell([bob.user.id]))).status).toBe(403)
    expect((await make(vic, id, tell([vic.user.id]))).status).toBe(403)
    const refused = async (r: object) => {
      const res = await make(ann, id, r)
      return [res.status, res.body.error]
    }
    expect(await refused(tell([]))).toEqual([400, 'That isn’t a rule this board can keep.'])
    const stranger = await Person.signUp(t.app, 'Sam')
    expect(await refused(tell([stranger.user.id]))).toEqual([422, 'That rule can’t be kept. Nobody it tells is on the board any more.'])
    expect(await refused(tell([ann.user.id, stranger.user.id]))).toEqual([422, 'That rule can’t be kept. Someone it tells isn’t on the board.'])
    expect(await refused(tell([ann.user.id], 'nowhere'))).toEqual([422, 'That rule can’t be kept. Its list is gone.'])
    expect(await refused({ ...tell([ann.user.id]), on: 'waits' })).toEqual([400, 'That isn’t a rule this board can keep.'])
    expect((await make(ann, id, tell([ASSIGNEE, vic.user.id]))).status).toBe(200)
  })

  it('says several cards in one line: many in one change, and one person’s moves within ten minutes', async () => {
    const { ann, bob, id, rule } = await team()
    await rule(tell([ann.user.id]))
    await move(bob, id, 'A3', 'doing')
    await move(bob, id, 'B2', 'doing')
    expect(await lines(ann)).toEqual(['Bob: Deploy, Book a photographer arrived in Doing'])
    expect((await told(ann))[0].task).toEqual({ id: 'A3', title: 'Deploy' })
    // Once seen, what comes next is a new line.
    await ann.ok('POST', '/api/notifications/read', {})
    await move(bob, id, 'C1', 'doing')
    expect(await lines(ann)).toEqual(['Bob: Pick a template arrived in Doing', 'Bob: Deploy, Book a photographer arrived in Doing'])
    // Cards from a spreadsheet arrive together: one line, the first ones named and the rest counted.
    await ann.ok('POST', '/api/notifications/read', {})
    const rows = Array.from({ length: 25 }, (_, i) => `Order ${i + 1}\tDoing`)
    const added = await bob.ok('POST', `/api/boards/${id}/tasks/import`, { text: ['Task\tStatus', ...rows].join('\n') })
    expect(added.added).toBe(25)
    const [line] = await told(ann)
    expect(line.cards).toHaveLength(20)
    expect([line.cards[0].title, line.more, line.moment]).toEqual(['Order 1', 5, 'arrived in Doing'])
  })

  it('tells whoever the card is assigned to: as it arrives, and as it was when it left', async () => {
    const { ann, bob, id, rule } = await team()
    await rule(tell([ASSIGNEE], 'todo', { on: 'leaves', name: 'Picked up' }))
    await rule(tell([ASSIGNEE], 'done'))
    // Deploy is Ann's. Bob takes it out of To Do: she hears it left. Homepage is nobody's: nobody hears.
    await move(bob, id, 'A3', 'doing')
    await move(bob, id, 'A2b', 'doing')
    expect(await lines(ann)).toEqual(['Bob: Deploy left To Do'])
    expect(await told(bob)).toEqual([])
    // Given to Bob as it is finished: he is the one it is assigned to as it arrives. Not for his own doing.
    await ann.ok('POST', '/api/notifications/read', {})
    await run(ann, id, { type: 'task.update', id: 'A3', fields: { status: 'done', assigneeId: bob.user.id } })
    expect(await lines(bob)).toEqual(['Ann: Deploy arrived in Done'])
    await run(bob, id, { type: 'task.update', id: 'B1', fields: { status: 'done', assigneeId: bob.user.id } })
    expect(await told(bob)).toHaveLength(1)
    // A condition besides the list: Urgent cards, wherever they are. Made Urgent, a card has arrived.
    await rule(tell([bob.user.id], '', { cards: { priorities: ['urgent'] }, name: 'Urgent' }))
    await run(ann, id, { type: 'task.update', id: 'C1', fields: { priority: 'urgent' } })
    expect((await lines(bob))[0]).toBe('Ann: Pick a template now fits “Urgent”')
  })

  it('doesn’t tell someone twice who also follows the card', async () => {
    const { ann, bob, id, rule } = await team()
    await rule(tell([ann.user.id]))
    // Ann follows Deploy (it's hers). Moved and given a due date in one change: the rule says where it went, and
    // as its follower she hears the rest.
    await run(bob, id, { type: 'task.update', id: 'A3', fields: { status: 'doing', due: '2026-10-15' } })
    const all = await bell(ann)
    expect(all.map((n: { kind: string }) => n.kind).sort()).toEqual(['change', 'rule'])
    expect(all.find((n: { kind: string }) => n.kind === 'change').changes).toEqual(['set “Deploy” due 15 Oct'])
    // A list no rule is about: she hears of the move as before.
    await ann.ok('POST', '/api/notifications/read', {})
    await move(bob, id, 'A3', 'done')
    expect((await bell(ann))[0]).toMatchObject({ kind: 'change', changes: ['moved “Deploy” to Done'] })
  })

  it('can be switched off by each person for themselves, which only the board’s owners see', async () => {
    const { ann, bob, vic, id, rule } = await team()
    const r = await rule(tell([ann.user.id, bob.user.id, vic.user.id]))
    const limit = (
      await make(ann, id, {
        kind: 'limit',
        cards: { statuses: ['doing'] },
        counts: 'leaves',
        measure: { by: 'cards' },
        max: 3,
        then: [{ do: 'show' }],
      })
    ).body.rule
    const mute = (p: Person, ruleId: string, muted: boolean, board = id) => p.request('PUT', `/api/boards/${board}/rules/${ruleId}/mute`, { muted })
    const mutes = (p: Person) => p.ok('GET', `/api/boards/${id}/rules/mutes`)
    expect(await mutes(vic)).toEqual({ mine: [] })
    expect((await mute(vic, r.id, true)).body).toEqual({ muted: true })
    expect((await mute(vic, r.id, true)).status).toBe(200)
    expect(await mutes(vic)).toEqual({ mine: [r.id] })
    expect(await mutes(bob)).toEqual({ mine: [] })
    expect(await mutes(ann)).toEqual({ mine: [], all: { [r.id]: [{ id: vic.user.id, name: 'Vic' }] } })
    // Nothing of it travels with the board, and the board didn't change.
    expect(JSON.stringify((await load(bob, id)).data)).not.toContain('mute')
    expect((await load(bob, id)).data.rules).toEqual([r, limit])

    await move(ann, id, 'A3', 'doing')
    expect(await told(vic)).toEqual([])
    expect(await lines(bob)).toEqual(['Ann: Deploy arrived in Doing'])
    await mute(vic, r.id, false)
    await move(ann, id, 'B2', 'doing')
    expect(await lines(vic)).toEqual(['Ann: Book a photographer arrived in Doing'])
    expect(await mutes(ann)).toEqual({ mine: [], all: {} })

    // Not a limit, not another board's rule, not a visitor with the public link, not a stranger.
    expect((await mute(bob, limit.id, true)).status).toBe(422)
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Ops', template: 'example' })
    expect((await mute(ann, r.id, true, other)).status).toBe(404)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const sam = await Person.signUp(t.app, 'Sam')
    expect((await mute(sam, r.id, true)).status).toBe(403)
    expect(await mutes(sam)).toEqual({ mine: [] })
    expect((await new Person(t.app).request('GET', `/api/boards/${id}/rules/mutes`)).status).toBe(401)
    // Removed with its rule.
    await mute(bob, r.id, true)
    await ann.ok('DELETE', `/api/boards/${id}/rules/${r.id}`)
    expect(await t.db.select().from(boardRuleMutes)).toEqual([])
    // What it said stays under the bell, without a rule to switch off.
    expect((await told(bob))[0]).toMatchObject({ rule: { id: null, name: '' }, moment: 'arrived in Doing' })
  })

  it('goes on telling the others when someone it names leaves the board', async () => {
    const { ann, bob, vic, id, rule } = await team()
    await rule(tell([bob.user.id, vic.user.id]))
    await ann.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    await move(ann, id, 'A3', 'doing')
    expect(await lines(vic)).toEqual(['Ann: Deploy arrived in Doing'])
    expect(await told(bob)).toEqual([])
    // With nobody left to tell it says so where rules are listed, and tells nobody.
    await ann.ok('DELETE', `/api/boards/${id}/members/${vic.user.id}`)
    await move(ann, id, 'B2', 'doing')
    expect(await told(vic)).toHaveLength(1)
  })

  it('hears of a card that moves to another board, on both boards, and keeps what it said where it said it', async () => {
    const { ann, bob, id, rule } = await team()
    const { id: shop } = await ann.ok('POST', '/api/boards', { name: 'Shop', template: 'empty' })
    await ann.ok('POST', `/api/boards/${shop}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await rule(tell([bob.user.id], 'doing', { on: 'leaves' }))
    await rule(tell([bob.user.id], 'todo'))
    const [first] = (await load(ann, shop)).data.columns
    expect((await make(ann, shop, tell([bob.user.id], first.id, { counts: 'topLevel' }))).status).toBe(200)

    // B1 (Send invites) is in Doing. Moved back to To Do, then to the other board.
    await move(ann, id, 'B1', 'todo')
    await bob.ok('POST', '/api/notifications/read', {})
    const moved = await ann.ok('POST', `/api/boards/${id}/tasks/B1/move`, { boardId: shop, list: first.id })
    const heard = await told(bob)
    expect(heard.map((n) => [n.board.id, n.cards[0].title, n.moment, n.read])).toEqual([
      [shop, 'Send invites', `arrived in ${first.name}`, false],
      // (What the first board's rules said about it before it moved is still that board's.)
      [id, 'Send invites', 'arrived in To Do', true],
      [id, 'Send invites', 'left Doing', true],
    ])
    expect(heard[0].task.id).toBe(moved.id)
  })

  it('takes an undo as the change it is, and says nothing when a list it is about comes or goes', async () => {
    const { ann, bob, id, rule } = await team()
    await rule(tell([bob.user.id], 'doing', { on: 'leaves' }))
    await rule(tell([bob.user.id], 'doing'))
    const undo = async (changes: Change[]) =>
      run(ann, id, { type: 'records.restore', changes: invertChanges((await load(ann, id)).data, changes, new Date().toISOString()) })
    const { changes } = await move(ann, id, 'A3', 'doing')
    await undo(changes)
    expect(await lines(bob)).toEqual(['Ann: Deploy left Doing', 'Ann: Deploy arrived in Doing'])
    // The list deleted (its cards go to To Do) and brought back by undo: neither rule can be worked out on one side.
    await bob.ok('POST', '/api/notifications/read', {})
    const gone = await run(ann, id, { type: 'column.delete', id: 'doing', moveTo: 'todo' })
    await undo(gone.changes)
    expect((await told(bob)).filter((n) => !n.read)).toEqual([])
    expect((await load(ann, id)).data.columns.some((c) => c.id === 'doing')).toBe(true)
  })

  it('reaches the desktop and the morning email, for people who want that', async () => {
    const { ann, bob, id, rule } = await team()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', { apiKey: 're_platform_1234567890abcd', from: 'Kanbanto <noreply@kanbanto.example>' })
    await t.db.update(users).set({ emailVerifiedAt: new Date() })
    const sent: { title: string; body: string; url: string; tag: string }[] = []
    t.app.push.transport = async (_sub, payload) => void sent.push(JSON.parse(payload))
    await ann.ok('POST', '/api/push/devices', { endpoint: 'https://push.example.com/ann-1', keys: { p256dh: 'BPk', auth: 'aa' }, label: 'Chrome' })
    const r = await rule(tell([ann.user.id], 'doing', { name: 'Started' }))
    // (A second rule about the same cards: still one message on the desktop for the change.)
    await rule(tell([ann.user.id], 'todo', { on: 'leaves' }))

    await move(bob, id, 'A3', 'doing')
    await new Promise((res) => setTimeout(res, 150))
    expect(sent).toMatchObject([
      { title: '“Deploy” arrived in Doing', body: 'Started · By Bob · My first board', url: `/#/b/${id}?task=A3`, tag: `rule:${id}:${r.id}` },
    ])
    // A card that left by being deleted has nothing to open but the board.
    await run(bob, id, { type: 'task.delete', id: 'A2b' })
    await new Promise((res) => setTimeout(res, 150))
    expect(sent[1]).toMatchObject({ title: '“Logo” left To Do', url: `/#/b/${id}` })
    // Their switch for the cards they follow covers it: off, nothing more on the desktop; the bell still has it.
    await ann.ok('PATCH', '/api/auth/me', { pushFollows: false })
    await move(bob, id, 'B2', 'doing')
    await new Promise((res) => setTimeout(res, 150))
    expect(sent).toHaveLength(2)
    expect((await lines(ann))[0]).toBe('Bob: Deploy, Book a photographer arrived in Doing')

    expect(await sendDigests(t.app, new Date('2026-10-01T08:05:00Z'))).toBe(1)
    await flushMail(t.app)
    const email = t.mail.last('ann@example.com')!
    expect(email.subject).toBe('Your day, Thu 1 Oct: 2 from board rules')
    expect(email.text).toContain('From your boards’ rules')
    expect(email.text).toContain('• “Deploy” and 1 more card (My first board) · arrived in Doing · by Bob · Started')
    expect(email.text).toContain('• “Deploy” and 1 more card (My first board) · left To Do · by Bob')
    expect(email.text).not.toContain('On cards you follow')
    // Said once: the next morning's has nothing of it.
    expect(await sendDigests(t.app, new Date('2026-10-02T08:05:00Z'))).toBe(0)
  })

  it('comes with a board read from a file only when it names nobody', async () => {
    const { ann, id, rule } = await team()
    await rule(tell([ann.user.id]))
    await rule(tell([ASSIGNEE], 'done', { name: 'Finished' }))
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file: exportFile((await load(ann, id)).data) })
    expect((await load(ann, made.id)).data.rules).toMatchObject([{ kind: 'when', name: 'Finished', then: [{ do: 'tell', who: [ASSIGNEE] }] }])
  })
})
