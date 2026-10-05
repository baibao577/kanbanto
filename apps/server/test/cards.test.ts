import type { CardRow, CardsPage } from '@kanbanto/model/api'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tasks } from '../src/db/schema'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const run = (p: Person, id: string, command: unknown) => p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const search = (p: Person, query: Record<string, string>) => p.ok<CardsPage>('GET', `/api/cards?${new URLSearchParams(query)}`)
const ids = (page: CardsPage) => page.cards.map((c) => c.id).sort()

/**
 * Ann and her first board, the example one: Launch website (A: A1 done; A2 with A2a doing and A2b to do; A3 to do; A4
 * in the backlog), Event (B: B1 doing, B2 backlog) and Newsletter redesign (C: C1 and C2 in the backlog). Hers: A, A1,
 * A3 and A4. Parents follow their subtasks.
 */
async function start() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  return { ann, id }
}

describe('searching cards across boards', () => {
  it('finds the cards on every board you can open, each saying where it lives; without `state`, the archived ones as before', async () => {
    const { ann } = await start()
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Home' })
    await run(ann, other, { type: 'task.create', id: 'h1', parentId: null, fields: { title: 'Fix the tap' } })

    const all = await search(ann, { state: 'active' })
    expect(all.total).toBe(14)
    expect(all.cards.find((c) => c.id === 'h1')).toMatchObject({
      board: { id: other, name: 'Home' },
      place: 'Personal',
      archived: false,
      list: 'To Do',
      kind: 'todo',
    })
    expect(all.cards.find((c) => c.id === 'A2a')).toMatchObject({ path: ['Launch website', 'Design'], list: 'Doing', done: false, canEdit: true })
    expect(all.people).toEqual([{ id: ann.user.id, name: 'Ann' }])
    expect(all.labels).toEqual(['brand', 'marketing', 'ui'])
    expect((await search(ann, { state: 'active', board: other })).total).toBe(1)
    expect((await search(ann, { state: 'active', place: 'personal' })).total).toBe(14)
    expect((await search(ann, { state: 'active', place: 'shared' })).total).toBe(0)
    expect((await ann.ok('GET', '/api/cards')).total).toBe(0)

    // In pages; what to filter by comes with the first one.
    const first = await search(ann, { state: 'active', limit: '5' })
    expect(first).toMatchObject({ total: 14, nextOffset: 5 })
    const next = await search(ann, { state: 'active', limit: '5', offset: '5' })
    expect(next.labels).toBeUndefined()
    expect(new Set([...ids(first), ...ids(next)]).size).toBe(10)
  })

  it('filters: mine and not done (My tasks), kinds of list, parents hidden, label, priority, due, words', async () => {
    const { ann, id } = await start()
    expect(ids(await search(ann, { state: 'active', assignee: 'me', completed: 'false' }))).toEqual(['A', 'A3', 'A4'])
    expect(ids(await search(ann, { state: 'active', assignee: ann.user.id, completed: 'true' }))).toEqual(['A1'])
    expect((await search(ann, { state: 'active', assignee: 'none' })).cards.every((c) => c.assignee === null)).toBe(true)
    // A parent shows in the list its subtasks put it in.
    expect(ids(await search(ann, { state: 'active', kind: 'doing' }))).toEqual(['A', 'A2', 'A2a', 'B', 'B1'])
    expect(ids(await search(ann, { state: 'active', kind: 'doing,done', parents: 'hide' }))).toEqual(['A1', 'A2a', 'B1'])
    expect(ids(await search(ann, { state: 'active', label: 'UI' }))).toEqual(['A2a'])
    await run(ann, id, { type: 'task.update', id: 'C1', fields: { priority: 'high', due: '2020-01-01' } })
    expect(ids(await search(ann, { state: 'active', priority: 'urgent,high' }))).toEqual(['C1'])
    expect((await search(ann, { state: 'active', priority: 'none' })).total).toBe(12)
    expect(ids(await search(ann, { state: 'active', due: 'overdue' }))).toContain('C1')
    expect(ids(await search(ann, { state: 'active', due: 'none' }))).not.toContain('C1')
    expect((await search(ann, { state: 'active', sort: 'priority' })).cards[0].id).toBe('C1')
    expect(ids(await search(ann, { state: 'active', q: 'launch BLOG' }))).toEqual(['A4'])
    expect((await ann.request('GET', '/api/cards?state=active&kind=nope')).status).toBe(400)
    expect((await ann.request('GET', '/api/cards?state=active&from=soon')).status).toBe(400)
  })

  it('words are found in comments too, with the part of the comment they were in', async () => {
    const { ann, id } = await start()
    await ann.ok('POST', `/api/boards/${id}/tasks/B2/comments`, { body: 'Somchai (100%) knows a good one: ask him before Friday', mentions: [] })
    const found = await search(ann, { state: 'active', q: 'photographer somchai' })
    expect(ids(found)).toEqual(['B2'])
    expect(found.cards[0].snippet).toMatch(/^Somchai \(100%\) knows/)
    expect(found.cards[0].atKind).toBe('changed')
    // Words in the title need no snippet; a wildcard is just a character.
    expect((await search(ann, { state: 'active', q: 'photographer' })).cards[0].snippet).toBeUndefined()
    expect(ids(await search(ann, { state: 'active', q: '100%' }))).toEqual(['B2'])
    expect((await search(ann, { state: 'active', q: '1_0%' })).total).toBe(0)
  })

  it('dates: when a card got done stays put through later edits and archiving; ranges ask about one date, or any', async () => {
    const { ann, id } = await start()
    // The example cards were made long ago; A1 got done 100 days back.
    await t.db.update(tasks).set({ createdAt: ago(200), updatedAt: ago(150), activeAt: ago(150) })
    await t.db
      .update(tasks)
      .set({ doneAt: ago(100) })
      .where(and(eq(tasks.boardId, id), eq(tasks.id, 'A1')))
    const between = (from: number, to: number) => ({ from: ago(from).toISOString(), to: ago(to).toISOString() })

    expect(ids(await search(ann, { state: 'all', when: 'done', ...between(120, 90) }))).toEqual(['A1'])
    expect((await search(ann, { state: 'all', when: 'done', ...between(90, 0) })).total).toBe(0)
    expect((await search(ann, { state: 'all', when: 'created', ...between(210, 190) })).total).toBe(13)
    // "Anything happened" then: A1 got done; nothing else was touched.
    const then = await search(ann, { state: 'all', ...between(120, 90) })
    expect(then.cards.map((c) => [c.id, c.atKind])).toEqual([['A1', 'done']])

    // Done today, then edited: still done when it was.
    await run(ann, id, { type: 'task.move', id: 'A3', status: 'done' })
    const [done] = (await search(ann, { state: 'all', when: 'done', assignee: 'me', from: ago(1).toISOString() })).cards
    expect(done).toMatchObject({ id: 'A3', done: true, atKind: 'done' })
    await new Promise((r) => setTimeout(r, 20))
    await run(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Deployed' } })
    const edited = (await search(ann, { state: 'all', when: 'done', from: ago(1).toISOString() })).cards[0] as CardRow
    expect(edited.doneAt).toBe(done.doneAt)
    expect(Date.parse(edited.activeAt)).toBeGreaterThan(Date.parse(done.activeAt))

    // Archived: out of the active cards, in "all" and the archived list, with its done date.
    await run(ann, id, { type: 'task.archive', id: 'A3' })
    expect(ids(await search(ann, { state: 'active', when: 'done', from: ago(1).toISOString() }))).toEqual([])
    const put = (await search(ann, { state: 'all', when: 'done', from: ago(1).toISOString() })).cards[0]
    expect(put).toMatchObject({ id: 'A3', archived: true, completed: true, doneAt: done.doneAt, list: 'Done' })
    expect((await search(ann, { state: 'archived', when: 'archived', from: ago(1).toISOString() })).cards[0]).toMatchObject({
      id: 'A3',
      atKind: 'archived',
    })
    // Newest first: the card just archived leads everything that happened today.
    expect((await search(ann, { state: 'all', from: ago(1).toISOString() })).cards[0].id).toBe('A3')
  })

  it('a card archived with its parent is found by its words, and counts among all cards, but isn’t a row in the archived list', async () => {
    const { ann, id } = await start()
    await run(ann, id, { type: 'task.archive', id: 'A2' })
    expect(ids(await search(ann, { state: 'archived' }))).toEqual(['A2'])
    expect((await search(ann, { state: 'archived' })).cards[0]).toMatchObject({ subtasks: 2, subtasksDone: 0, kind: null })
    expect(ids(await search(ann, { state: 'archived', q: 'logo' }))).toEqual(['A2b'])
    // (With its design put away, Launch website is still under way: one subtask is done.)
    expect(ids(await search(ann, { state: 'all', kind: 'doing' }))).toEqual(['A', 'B', 'B1'])
    expect((await search(ann, { state: 'all' })).total).toBe(13)
  })

  it('by one of the boards’ own fields: what each card has for it, and only the ones that pass, on the boards that use it', async () => {
    const { ann, id } = await start()
    const add = async (body: object) => (await ann.ok('POST', '/api/fields', body)).id as string
    const value = await add({ name: 'Value', type: 'number', unit: '$', decimals: 0, sum: true })
    const signed = await add({ name: 'Signed', type: 'checkbox' })
    const stage = await add({
      name: 'Stage',
      type: 'choice',
      options: [
        { name: 'Lead', color: 'gray' },
        { name: 'Won', color: 'green' },
      ],
    })
    const library = (await ann.ok('GET', '/api/fields')).fields as { id: string; options?: { id: string }[] }[]
    const [lead, won] = library.find((f) => f.id === stage)!.options!.map((o) => o.id)
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: stage }, { id: value }, { id: signed }] })
    // A board that doesn't use the fields: none of its cards can pass a test of one.
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Home' })
    await run(ann, other, { type: 'task.create', id: 'h1', parentId: null, fields: { title: 'Fix the tap' } })
    await run(ann, id, { type: 'task.update', id: 'A1', fields: { custom: { [stage]: [won], [value]: 1200, [signed]: true } } })
    await run(ann, id, { type: 'task.update', id: 'A3', fields: { custom: { [stage]: [lead], [value]: 300 } } })
    await run(ann, id, { type: 'task.update', id: 'B1', fields: { custom: { [value]: 0 } } })

    // What can be asked about comes with the first page, as the library defines it.
    const all = await search(ann, { state: 'active' })
    expect(all.fields?.map((f) => f.name)).toEqual(['Signed', 'Stage', 'Value'])
    expect(all.fields?.find((f) => f.id === stage)).not.toHaveProperty('front')
    expect(all.cards.every((c) => c.field === undefined)).toBe(true)

    // Asked about a field: each card says what it has; nothing is left out until a test is given.
    const told = await search(ann, { state: 'active', field: stage })
    expect(told.total).toBe(all.total)
    expect(told.cards.find((c) => c.id === 'A1')?.field).toEqual({ name: 'Stage', text: 'Won' })
    expect(told.cards.find((c) => c.id === 'A2')?.field).toBeUndefined()

    const by = (field: string, fv: string, more: Record<string, string> = {}) => search(ann, { state: 'active', field, fv, ...more })
    expect(ids(await by(stage, won))).toEqual(['A1'])
    expect(ids(await by(stage, `${won},${lead}`))).toEqual(['A1', 'A3'])
    // "None picked" is about the boards that use the field: the other board's card isn't one of them.
    const none = await by(stage, '-')
    expect(none.total).toBe(11)
    expect(ids(none)).not.toContain('h1')
    expect(ids(await by(signed, 'yes'))).toEqual(['A1'])
    expect((await by(signed, 'no')).total).toBe(12)
    expect(ids(await by(value, 'any'))).toEqual(['A1', 'A3', 'B1'])
    expect(ids(await by(value, '0..500'))).toEqual(['A3', 'B1'])
    expect(ids(await by(value, '1000..'))).toEqual(['A1'])
    expect((await by(value, '1000..')).cards[0].field).toEqual({ name: 'Value', text: '$1,200' })
    expect((await by(value, 'none')).total).toBe(10)
    // With the other filters; and an archived card keeps what it had.
    expect(ids(await by(value, 'any', { completed: 'true' }))).toEqual(['A1'])
    await run(ann, id, { type: 'task.archive', id: 'A3' })
    expect(ids(await search(ann, { state: 'archived', field: stage, fv: lead }))).toEqual(['A3'])

    // Something this kind of field can't be asked says what can; a field no board has finds nothing.
    const bad = await ann.request('GET', `/api/cards?state=active&field=${signed}&fv=maybe`)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/Signed.*yes.*no/)
    expect((await by('nope', 'any')).total).toBe(0)
  })

  it('only boards you can open; a viewer’s rows can’t be changed; archived boards only with archived cards', async () => {
    const { ann, id } = await start()
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/tasks/B2/comments`, { body: 'Ask Somchai', mentions: [] })
    expect((await search(bob, { state: 'active' })).cards.every((c) => c.board.id !== id)).toBe(true)
    expect((await search(bob, { state: 'active', q: 'somchai' })).total).toBe(0)
    expect((await bob.request('GET', `/api/cards?state=active&board=${id}`)).status).toBe(404)

    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'viewer' })
    await bob.ok('POST', '/api/join', { invite: link.token })
    const shared = await search(bob, { state: 'active', place: 'shared' })
    expect(shared.total).toBe(13)
    expect(shared.cards[0]).toMatchObject({ place: 'Shared with you', canEdit: false })
    expect(ids(await search(bob, { state: 'active', q: 'somchai' }))).toEqual(['B2'])
    // "me" is whoever asks.
    expect((await search(bob, { state: 'active', board: id, assignee: 'me' })).total).toBe(0)

    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    expect((await search(ann, { state: 'active' })).total).toBe(0)
    expect((await search(ann, { state: 'all' })).total).toBe(13)
    expect((await search(ann, { state: 'active', board: id })).total).toBe(13)
  })
})
