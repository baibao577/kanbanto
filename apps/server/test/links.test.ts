import type { LinkedFrom } from '@kanbanto/model/api'
import { linkRef } from '@kanbanto/model/fields'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tasks } from '../src/db/schema'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok('GET', `/api/boards/${id}`)
const mutate = (p: Person, id: string, command: object) => p.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const set = (p: Person, id: string, taskId: string, custom: object) => mutate(p, id, { type: 'task.update', id: taskId, fields: { custom } })
const add = async (p: Person, id: string, taskId: string, title: string, custom?: object) => {
  const r = await mutate(p, id, { type: 'task.create', id: taskId, parentId: null, fields: { title, ...(custom && { custom }) } })
  expect(r.status).toBe(200)
}
const stored = async (boardId: string, taskId: string) =>
  (
    await t.db
      .select({ custom: tasks.custom })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), eq(tasks.id, taskId)))
  )[0]?.custom
const pick = (p: Person, id: string, fields: { id: string; front?: boolean; total?: boolean }[]) =>
  p.ok('PUT', `/api/boards/${id}/fields`, { fields })

/**
 * Ann's workspace Acme with Bob in it, and two boards there: Deals (d1, d2, d3) and Companies (c1 "Acme", c2
 * "Globex"). Three link fields of the workspace on Deals: Company (one card of Companies), Related (cards of the same
 * board) and Anything (cards of any board in the workspace), plus Value, a number that adds up.
 */
async function crm() {
  const ann = await Person.signUp(t.app, 'Ann')
  const bob = await Person.signUp(t.app, 'Bob')
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
  const board = async (name: string, workspaceId: string | null = ws) => (await ann.ok('POST', '/api/boards', { name, workspaceId })).id as string
  const deals = await board('Deals')
  const companies = await board('Companies')
  const field = async (body: object) => (await ann.ok('POST', `/api/workspaces/${ws}/fields`, body)).id as string
  const company = await field({ name: 'Company', type: 'link', linkTo: 'board', board: companies, back: 'Deals' })
  const related = await field({ name: 'Related', type: 'link', linkTo: 'same', many: true })
  const anything = await field({ name: 'Anything', type: 'link', linkTo: 'space', many: true })
  const value = await field({ name: 'Value', type: 'number', unit: '$', decimals: 0, sum: true })
  await pick(ann, deals, [{ id: company }, { id: related }, { id: anything }, { id: value, total: true }])
  await add(ann, deals, 'd1', 'Website redesign')
  await add(ann, deals, 'd2', 'Online shop')
  await add(ann, deals, 'd3', 'Retainer')
  await add(ann, companies, 'c1', 'Acme')
  await add(ann, companies, 'c2', 'Globex')
  return {
    ann,
    bob,
    ws,
    deals,
    companies,
    company,
    related,
    anything,
    value,
    board,
    field,
    c1: linkRef(companies, 'c1'),
    c2: linkRef(companies, 'c2'),
  }
}

describe('a link field', () => {
  it('says where its cards come from: a board of its own space, this board, or any board there', async () => {
    const { ann, bob, ws, companies, company, field } = await crm()
    const base = `/api/workspaces/${ws}/fields`
    const view = (await ann.ok('GET', base)).fields.find((f: { id: string }) => f.id === company)
    expect(view).toMatchObject({ type: 'link', linkTo: 'board', board: companies, back: 'Deals' })
    expect(view.many).toBeUndefined()
    // A board has to be named, be in this workspace, and be one the admin can open.
    expect((await ann.request('POST', base, { name: 'No board', type: 'link', linkTo: 'board' })).status).toBe(400)
    const { id: personal } = await ann.ok('POST', '/api/boards', { name: 'Mine' })
    expect((await ann.request('POST', base, { name: 'Elsewhere', type: 'link', linkTo: 'board', board: personal })).body.error).toMatch(
      /this workspace’s boards/,
    )
    expect((await ann.request('POST', base, { name: 'Nowhere', type: 'link', linkTo: 'board', board: 'nope' })).status).toBe(400)
    // In someone's own library: one of their own boards.
    expect((await bob.request('POST', '/api/fields', { name: 'Theirs', type: 'link', linkTo: 'board', board: companies })).body.error).toMatch(
      /your own boards/,
    )
    const mine = await ann.ok('POST', '/api/fields', { name: 'Project', type: 'link', linkTo: 'board', board: personal })
    expect(mine.fields.find((f: { id: string }) => f.id === mine.id)).toMatchObject({ linkTo: 'board', board: personal })
    // Not said: any board of the space. Changing it keeps what isn't named.
    const any = await field({ name: 'Loose', type: 'link' })
    await ann.ok('PATCH', `${base}/${any}`, { many: true })
    expect((await ann.ok('GET', base)).fields.find((f: { id: string }) => f.id === any)).toMatchObject({ linkTo: 'space', many: true })
  })
})

describe('linking a card', () => {
  it('is checked against the field, the space, what the person can open, and that the card is there', async () => {
    const { ann, bob, deals, companies, company, related, anything, board, c1, c2 } = await crm()
    expect((await set(ann, deals, 'd1', { [company]: [c1] })).status).toBe(200)
    expect(await stored(deals, 'd1')).toEqual({ [company]: [c1] })
    // One card, of the board the field names.
    expect((await set(ann, deals, 'd1', { [company]: [c1, c2] })).body.error).toMatch(/Company: This field holds one card/)
    expect((await set(ann, deals, 'd2', { [company]: [linkRef(deals, 'd1')] })).body.error).toMatch(/isn’t on the board this field links to/)
    expect((await set(ann, deals, 'd2', { [company]: ['not a link'] })).body.error).toMatch(/That isn’t a card/)
    // Cards of the same board: not another board's, not itself, and they have to be there.
    expect((await set(ann, deals, 'd1', { [related]: [linkRef(deals, 'd2'), linkRef(deals, 'd3')] })).status).toBe(200)
    expect((await set(ann, deals, 'd2', { [related]: [c1] })).body.error).toMatch(/links cards on the same board/)
    expect((await set(ann, deals, 'd2', { [related]: [linkRef(deals, 'd2')] })).body.error).toMatch(/can’t link to itself/)
    expect((await set(ann, deals, 'd2', { [related]: [linkRef(deals, 'zzz')] })).body.error).toMatch(/isn’t on this board any more/)

    // Any board of the space, as far as the person can open it. What fails reads the same whether the card exists.
    const hidden = await board('Private')
    await ann.ok('PATCH', `/api/boards/${hidden}/sharing`, { visibility: 'private' })
    await add(ann, hidden, 'h1', 'Secret plan')
    const refused = /that card doesn’t exist, or you can’t open its board/
    expect((await set(bob, deals, 'd2', { [anything]: [linkRef(hidden, 'h1')] })).body.error).toMatch(refused)
    expect((await set(bob, deals, 'd2', { [anything]: [linkRef(hidden, 'nope')] })).body.error).toMatch(refused)
    expect((await set(bob, deals, 'd2', { [anything]: [linkRef(companies, 'nope')] })).body.error).toMatch(refused)
    expect((await set(bob, deals, 'd2', { [anything]: [c2] })).status).toBe(200)
    // Ann can open it, so she can link it; and Bob can still add his own link beside hers.
    expect((await set(ann, deals, 'd2', { [anything]: [c2, linkRef(hidden, 'h1')] })).status).toBe(200)
    expect((await set(bob, deals, 'd2', { [anything]: [c2, linkRef(hidden, 'h1'), c1] })).status).toBe(200)

    // Never across spaces: Ann's own board, another workspace's, one that doesn't exist. All read the same.
    const mine = await board('Mine', null)
    await add(ann, mine, 'm1', 'Mine')
    const { id: other } = await ann.ok('POST', '/api/workspaces', { name: 'Other' })
    const far = (await ann.ok('POST', '/api/boards', { name: 'Far', workspaceId: other })).id
    await add(ann, far, 'f1', 'Far away')
    const outside = /Anything: a link stays inside one workspace/
    for (const ref of [linkRef(mine, 'm1'), linkRef(far, 'f1'), linkRef('01900000-0000-7000-8000-000000000000', 'x')])
      expect((await set(ann, deals, 'd3', { [anything]: [ref] })).body.error).toMatch(outside)
    // A board open only by its public link isn't one "you can open".
    const sue = await Person.signUp(t.app, 'Sue')
    const { id: sues } = await sue.ok('POST', '/api/boards', { name: 'Sue’s' })
    const { id: sueField } = await sue.ok('POST', '/api/fields', { name: 'Peek', type: 'link', many: true })
    await pick(sue, sues, [{ id: sueField }])
    await add(sue, sues, 's1', 'Hers')
    await ann.ok('PATCH', `/api/boards/${mine}/sharing`, { publicLink: true })
    expect((await set(sue, sues, 's1', { [sueField]: [linkRef(mine, 'm1')] })).status).toBe(422)
    expect(await stored(deals, 'd3')).toBeNull()
  })

  it('an undo that would bring back a link the person may not make goes through without it', async () => {
    const { ann, bob, deals, anything, board, c1 } = await crm()
    const hidden = await board('Private')
    await ann.ok('PATCH', `/api/boards/${hidden}/sharing`, { visibility: 'private' })
    await add(ann, hidden, 'h1', 'Secret plan')
    const before = (await load(bob, deals)).data.tasks.d1
    // A crafted undo: the card "as it was", holding a link Bob could never have made, and one he could.
    const after = { ...before, title: 'Renamed back', custom: { [anything]: [c1, linkRef(hidden, 'h1')] } }
    const r = await mutate(bob, deals, { type: 'records.restore', changes: [{ entity: 'task', id: 'd1', before, after }] })
    expect(r.status).toBe(200)
    expect(await stored(deals, 'd1')).toEqual({ [anything]: [c1] })
    expect((await load(bob, deals)).data.tasks.d1.title).toBe('Renamed back')
  })

  it('twenty at once all finish', async () => {
    const { ann, deals, anything, c1, c2 } = await crm()
    for (let i = 0; i < 20; i++) await add(ann, deals, `x${i}`, `Deal ${i}`)
    const done = await Promise.all(Array.from({ length: 20 }, (_, i) => set(ann, deals, `x${i}`, { [anything]: [i % 2 ? c1 : c2] })))
    expect(done.map((r) => r.status)).toEqual(Array(20).fill(200))
  })
})

describe('what a link points at', () => {
  it('is read for the person looking: a title they may see, a card that’s gone, or nothing at all', async () => {
    const { ann, bob, deals, companies, company, related, anything, board, c1 } = await crm()
    const hidden = await board('Private')
    await ann.ok('PATCH', `/api/boards/${hidden}/sharing`, { visibility: 'private' })
    await add(ann, hidden, 'h1', 'Secret plan')
    const secret = linkRef(hidden, 'h1')
    await set(ann, deals, 'd1', { [company]: [c1], [anything]: [secret], [related]: [linkRef(deals, 'd2'), linkRef(deals, 'd3')] })

    const mine = await load(ann, deals)
    expect(mine.linked[c1]).toEqual({ title: 'Acme', board: { id: companies, name: 'Companies' }, list: 'To Do', kind: 'todo', done: false })
    expect(mine.linked[secret]).toMatchObject({ title: 'Secret plan' })
    // (Cards among this board's active ones aren't in it: the board itself has them.)
    expect(mine.linked[linkRef(deals, 'd2')]).toBeUndefined()
    expect(mine.canBeLinked).toBe(true)

    // Bob can't open that board: the same answer as for a card that was never there, and no title anywhere.
    const his = await load(bob, deals)
    expect(his.linked[c1]).toMatchObject({ title: 'Acme' })
    expect(his.linked[secret]).toEqual({ hidden: true })
    const asked = await bob.ok('GET', `/api/boards/${deals}/linked?refs=${encodeURIComponent(secret)},${encodeURIComponent(linkRef(hidden, 'nope'))}`)
    expect(asked.linked).toEqual({ [secret]: { hidden: true } })
    const log = JSON.stringify(await bob.ok('GET', `/api/boards/${deals}/activity`))
    expect(log).not.toContain('Secret plan')
    expect(log).not.toContain('Acme')
    expect(log).toContain('set Company of “Website redesign” to a card on another board')
    expect(log).toContain('set Related of “Website redesign” to “Online shop”, “Retainer”')

    // Archived on the same board: still a card, greyed. Deleted: gone, until an undo brings it back.
    await mutate(ann, deals, { type: 'task.archive', id: 'd2' })
    await mutate(ann, deals, { type: 'task.delete', id: 'd3' })
    await mutate(ann, companies, { type: 'task.archive', id: 'c1' })
    const later = await load(ann, deals)
    expect(later.linked[linkRef(deals, 'd2')]).toMatchObject({ title: 'Online shop', archived: true })
    expect(later.linked[linkRef(deals, 'd3')]).toEqual({ gone: true })
    expect(later.linked[c1]).toMatchObject({ title: 'Acme', archived: true })

    // With only the public link: cards of the same board, and nothing of any other.
    await ann.ok('PATCH', `/api/boards/${deals}/sharing`, { publicLink: true })
    const visitor = await new Person(t.app).ok('GET', `/api/boards/${deals}`)
    expect(visitor.linked[linkRef(deals, 'd2')]).toMatchObject({ title: 'Online shop' })
    expect(visitor.linked[c1]).toEqual({ hidden: true })
    expect(visitor.canBeLinked).toBeUndefined()
  })

  it('the picker offers the cards the field allows, by title', async () => {
    const { ann, bob, deals, companies, company, related, anything, board } = await crm()
    const cards = async (p: Person, fieldId: string, q = '', task = 'd1') =>
      (await p.ok('GET', `/api/boards/${deals}/fields/${fieldId}/cards?q=${encodeURIComponent(q)}&task=${task}`)) as {
        cards: { ref: string; title: string; board: { name: string } }[]
        problem?: string
      }
    expect((await cards(ann, company)).cards.map((c) => c.title).sort()).toEqual(['Acme', 'Globex'])
    expect((await cards(ann, company, 'glo')).cards).toMatchObject([{ ref: linkRef(companies, 'c2'), title: 'Globex', board: { name: 'Companies' } }])
    // This board's cards, without the card itself.
    expect((await cards(ann, related)).cards.map((c) => c.title).sort()).toEqual(['Online shop', 'Retainer'])
    // Any board of the space the person can open: not a private one, for Bob.
    const hidden = await board('Private')
    await ann.ok('PATCH', `/api/boards/${hidden}/sharing`, { visibility: 'private' })
    await add(ann, hidden, 'h1', 'Secret plan')
    expect((await cards(ann, anything, 'secret')).cards.map((c) => c.title)).toEqual(['Secret plan'])
    expect((await cards(bob, anything, 'secret')).cards).toEqual([])
    expect((await cards(bob, anything, 'acme')).cards.map((c) => c.title)).toEqual(['Acme'])
    // The field's board is gone: nothing to pick, and why.
    await ann.ok('DELETE', `/api/boards/${companies}`)
    expect(await cards(ann, company)).toMatchObject({ cards: [], problem: expect.stringMatching(/is gone/) })
  })

  it('the other card lists who links to it, with totals; boards the person can’t open are only counted', async () => {
    const { ann, bob, deals, companies, company, anything, value, board, c1 } = await crm()
    await set(ann, deals, 'd1', { [company]: [c1], [value]: 1200 })
    await set(ann, deals, 'd2', { [company]: [c1], [value]: 300 })
    await set(ann, deals, 'd3', { [anything]: [c1] })
    const hidden = await board('Private')
    await ann.ok('PATCH', `/api/boards/${hidden}/sharing`, { visibility: 'private' })
    await pick(ann, hidden, [{ id: anything }])
    await add(ann, hidden, 'h1', 'Secret plan', { [anything]: [c1] })

    const from = (p: Person) => p.ok<LinkedFrom>('GET', `/api/boards/${companies}/tasks/c1/linked-from`)
    const hers = await from(ann)
    expect(hers.hidden).toBe(0)
    expect(hers.groups.map((g) => [g.board.name, g.field.name, g.field.back, g.cards.map((c) => c.title), g.totals])).toEqual([
      ['Deals', 'Company', 'Deals', ['Website redesign', 'Online shop'], [{ name: 'Value', text: '$1,500' }]],
      ['Deals', 'Anything', undefined, ['Retainer'], []],
      ['Private', 'Anything', undefined, ['Secret plan'], []],
    ])
    const his = await from(bob)
    expect(his.groups.map((g) => g.board.name)).toEqual(['Deals', 'Deals'])
    expect(his.hidden).toBe(1)
    expect(JSON.stringify(his)).not.toContain('Secret')
    expect((await from(ann)).groups[0].cards[0]).toEqual({ id: 'd1', title: 'Website redesign', list: 'To Do', kind: 'todo', done: false })
  })
})

describe('when the linked card moves or goes', () => {
  it('a move inside the space is followed; one out of it removes the link, and says so', async () => {
    const { ann, deals, companies, company, anything, board, c1, c2 } = await crm()
    await set(ann, deals, 'd1', { [company]: [c1], [anything]: [c1, c2] })
    await set(ann, deals, 'd2', { [anything]: [c2] })
    // (A subtask of the card that moves is linked too.)
    await mutate(ann, companies, { type: 'task.create', id: 'c1a', parentId: 'c1', fields: { title: 'Acme UK' } })
    await set(ann, deals, 'd3', { [anything]: [linkRef(companies, 'c1a')] })
    const partners = await board('Partners')
    const before = (await load(ann, deals)).seq

    const moved = await ann.ok('POST', `/api/boards/${companies}/tasks/c1/move`, { boardId: partners })
    expect(moved.summary.linksRemoved).toBe(0)
    const there = linkRef(partners, moved.id)
    const now = await load(ann, deals)
    expect(now.seq).toBeGreaterThan(before)
    // (Company names the Companies board, but a link that was there is never refused: it follows its card.)
    expect(now.data.tasks.d1.custom).toEqual({ [company]: [there], [anything]: [there, c2] })
    expect(now.linked[there]).toMatchObject({ title: 'Acme', board: { name: 'Partners' } })
    const sub = now.data.tasks.d3.custom[anything][0]
    expect(now.linked[sub]).toMatchObject({ title: 'Acme UK', board: { name: 'Partners' } })
    // A later edit on the linking board keeps the new link (its copy in memory was refreshed).
    expect((await set(ann, deals, 'd1', { [anything]: [there] })).status).toBe(200)
    expect(await stored(deals, 'd1')).toEqual({ [company]: [there], [anything]: [there] })

    // Out of the space: the links to it go.
    const mine = await board('Mine', null)
    const gone = await ann.ok('POST', `/api/boards/${companies}/tasks/c2/move`, { boardId: mine })
    expect(gone.summary.linksRemoved).toBe(1)
    expect((await load(ann, deals)).data.tasks.d2.custom).toBeUndefined()
  })

  it('the moving card takes its own links along where the other board uses the field, renumbering the ones to itself', async () => {
    const { ann, deals, company, related, c1, board } = await crm()
    await mutate(ann, deals, { type: 'task.create', id: 'd1a', parentId: 'd1', fields: { title: 'Kick-off' } })
    await set(ann, deals, 'd1', { [company]: [c1], [related]: [linkRef(deals, 'd1a'), linkRef(deals, 'd2')] })
    const pipeline = await board('Pipeline')
    await pick(ann, pipeline, [{ id: company }, { id: related }])
    const moved = await ann.ok('POST', `/api/boards/${deals}/tasks/d1/move`, { boardId: pipeline })
    expect(moved.summary.droppedFields).toEqual([])
    const there = (await load(ann, pipeline)).data.tasks
    const sub = Object.values(there as Record<string, { id: string; title: string }>).find((x) => x.title === 'Kick-off')!.id
    expect(there[moved.id].custom).toEqual({ [company]: [c1], [related]: [linkRef(pipeline, sub), linkRef(deals, 'd2')] })
    // A field that's only named alike (another space's) takes nothing.
    const mine = await board('Mine', null)
    const { id: own } = await ann.ok('POST', '/api/fields', { name: 'Company', type: 'link' })
    await pick(ann, mine, [{ id: own }])
    const out = await ann.ok('POST', `/api/boards/${pipeline}/tasks/${moved.id}/move`, { boardId: mine })
    expect(out.summary.droppedFields.sort()).toEqual(['Company', 'Related'])
    expect((await load(ann, mine)).data.tasks[out.id].custom).toBeUndefined()
  })

  it('a board that’s deleted takes the links to its cards with it', async () => {
    const { ann, deals, companies, company, anything, related, c1 } = await crm()
    await set(ann, deals, 'd1', { [company]: [c1], [anything]: [c1, linkRef(deals, 'd2')], [related]: [linkRef(deals, 'd3')] })
    await ann.ok('DELETE', `/api/boards/${companies}`)
    const now = await load(ann, deals)
    expect(now.data.tasks.d1.custom).toEqual({ [anything]: [linkRef(deals, 'd2')], [related]: [linkRef(deals, 'd3')] })
    // The field still names the board that's gone: it isn't widened to every board.
    expect(now.data.fields.find((f: { id: string }) => f.id === company)).toMatchObject({ linkTo: 'board', board: companies })
  })

  it('a board leaving its space says how many links that undoes, and keeps the ones between its own cards', async () => {
    const { ann, deals, companies, company, related, c1 } = await crm()
    await set(ann, deals, 'd1', { [company]: [c1], [related]: [linkRef(deals, 'd2')] })
    const { id: back } = await ann.ok('POST', `/api/workspaces/${(await load(ann, deals)).access.workspace.id}/fields`, {
      name: 'Deal',
      type: 'link',
      many: true,
    })
    await pick(ann, companies, [{ id: back }])
    await set(ann, companies, 'c2', { [back]: [linkRef(deals, 'd3')] })

    const asked = await ann.request('PUT', `/api/boards/${deals}/workspace`, { workspaceId: null })
    expect(asked.status).toBe(409)
    expect(asked.body).toMatchObject({ code: 'fields', links: 2 })
    await ann.ok('PUT', `/api/boards/${deals}/workspace`, { workspaceId: null, confirm: true })
    const moved = await load(ann, deals)
    const mine = (await ann.ok('GET', '/api/fields')).fields as { id: string; name: string; linkTo?: string; board?: string }[]
    const by = (name: string) => mine.find((f) => f.name === name)!
    // Its link to the company is gone; the one between its own cards came along; the company's link to it is gone.
    expect(moved.data.tasks.d1.custom).toEqual({ [by('Related').id]: [linkRef(deals, 'd2')] })
    expect((await load(ann, companies)).data.tasks.c2.custom).toBeUndefined()
    // The field that named a board left behind arrives naming none.
    expect(by('Company')).toMatchObject({ linkTo: 'board' })
    expect(by('Company').board).toBeUndefined()
  })

  it('an imported board keeps the links between its own cards, under its new id', async () => {
    const { ann, deals, company, related, c1 } = await crm()
    await set(ann, deals, 'd1', { [company]: [c1], [related]: [linkRef(deals, 'd2')] })
    const file = { app: 'kanbanto', format: 3, data: (await ann.ok('GET', `/api/boards/${deals}?archived=all`)).data }
    const sue = await Person.signUp(t.app, 'Sue')
    const { id } = await sue.ok('POST', '/api/boards/import', { file })
    const hers = (await sue.ok('GET', '/api/fields')).fields as { id: string; name: string; board?: string }[]
    const by = (name: string) => hers.find((f) => f.name === name)!
    const board = await load(sue, id)
    expect(board.data.tasks.d1.custom).toEqual({ [by('Related').id]: [linkRef(id, 'd2')] })
    expect(by('Company').board).toBeUndefined()
    expect(JSON.stringify(board)).not.toContain(deals)
  })
})

describe('finding cards by a link', () => {
  it('Search cards: the ones that have a link, or none', async () => {
    const { ann, bob, deals, companies, company, c1 } = await crm()
    await set(ann, deals, 'd1', { [company]: [c1] })
    const search = (fv: string) => ann.ok('GET', `/api/cards?state=active&board=${deals}&field=${company}&fv=${fv}`)
    expect((await search('any')).cards.map((c: { id: string }) => c.id)).toEqual(['d1'])
    expect((await search('none')).total).toBe(2)
    // What a card has for it reads as the card's title, for someone who may see it; never as the link itself.
    expect((await search('any')).cards[0].field).toEqual({ name: 'Company', text: 'Acme' })
    await ann.ok('PATCH', `/api/boards/${companies}/sharing`, { visibility: 'private' })
    const his = await bob.ok('GET', `/api/cards?state=active&board=${deals}&field=${company}&fv=any`)
    expect(his.cards[0].field).toEqual({ name: 'Company', text: 'a card' })
  })
})
