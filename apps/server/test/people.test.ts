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
const add = async (p: Person, id: string, taskId: string, title: string, fields: object = {}) => {
  const r = await mutate(p, id, { type: 'task.create', id: taskId, parentId: null, fields: { title, ...fields } })
  expect(r.status).toBe(200)
}
const row = async (boardId: string, taskId: string) =>
  (
    await t.db
      .select({ custom: tasks.custom, assigneeId: tasks.assigneeId })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), eq(tasks.id, taskId)))
  )[0]
const pick = (p: Person, id: string, fields: { id: string; front?: boolean }[]) => p.ok('PUT', `/api/boards/${id}/fields`, { fields })

/**
 * Ann's workspace Acme with Bob in it (Cy is nobody there), and the board Deals (d1, d2), shared with the workspace.
 * Two person fields of the workspace on it: Reviewer (one person) and Team (several).
 */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const bob = await Person.signUp(t.app, 'Bob')
  const cy = await Person.signUp(t.app, 'Cy')
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
  const board = async (name: string, workspaceId: string | null = ws) => (await ann.ok('POST', '/api/boards', { name, workspaceId })).id as string
  const deals = await board('Deals')
  const field = async (body: object) => (await ann.ok('POST', `/api/workspaces/${ws}/fields`, body)).id as string
  const reviewer = await field({ name: 'Reviewer', type: 'person' })
  const squad = await field({ name: 'Team', type: 'person', many: true })
  await pick(ann, deals, [{ id: reviewer, front: true }, { id: squad }])
  await add(ann, deals, 'd1', 'Website redesign')
  await add(ann, deals, 'd2', 'Online shop')
  return { ann, bob, cy, ws, deals, reviewer, squad, board, field, A: ann.user.id, B: bob.user.id, C: cy.user.id }
}

describe('a person field', () => {
  it('holds one person or several, which can be changed later', async () => {
    const { ann, ws, reviewer, squad } = await team()
    const base = `/api/workspaces/${ws}/fields`
    const view = async (id: string) => (await ann.ok('GET', base)).fields.find((f: { id: string }) => f.id === id)
    expect(await view(reviewer)).toMatchObject({ type: 'person' })
    expect((await view(reviewer)).many).toBeUndefined()
    expect(await view(squad)).toMatchObject({ type: 'person', many: true })
    await ann.ok('PATCH', `${base}/${reviewer}`, { many: true })
    expect(await view(reviewer)).toMatchObject({ many: true })
    // Settings of other kinds mean nothing to it.
    await ann.ok('PATCH', `${base}/${reviewer}`, { unit: '$', many: false })
    expect(await view(reviewer)).not.toHaveProperty('unit')
    expect((await view(reviewer)).many).toBeUndefined()
    expect((await ann.request('POST', base, { name: 'Assignee', type: 'person' })).body.error).toMatch(/Every card already has/)
  })
})

describe('putting people on a card', () => {
  it('only the board’s people, whoever is there through the workspace included', async () => {
    const { ann, bob, deals, reviewer, squad, A, B, C } = await team()
    expect((await set(ann, deals, 'd1', { [reviewer]: [B], [squad]: [A, B] })).status).toBe(200)
    expect((await row(deals, 'd1')).custom).toEqual({ [reviewer]: [B], [squad]: [A, B] })
    expect((await load(bob, deals)).data.tasks.d1.custom).toEqual({ [reviewer]: [B], [squad]: [A, B] })
    // Someone who isn't on the board, an id that's nobody's, two people where one fits.
    expect((await set(ann, deals, 'd2', { [reviewer]: [C] })).body.error).toMatch(/Reviewer: That person isn’t on this board/)
    expect((await set(ann, deals, 'd2', { [squad]: [A, '01900000-0000-7000-8000-00000000dead'] })).body.error).toMatch(/isn’t on this board/)
    expect((await set(ann, deals, 'd2', { [reviewer]: [A, B] })).body.error).toMatch(/holds one person/)
    expect((await row(deals, 'd2')).custom).toBeNull()
    // The log names them, never their ids.
    const log = JSON.stringify(await ann.ok('GET', `/api/boards/${deals}/activity`))
    expect(log).toContain('set Team of “Website redesign” to Ann, Bob')
    expect(log).not.toContain(B)
  })

  it('an undo that names a stranger puts back everything else and leaves them out', async () => {
    const { ann, deals, squad, A, C } = await team()
    await set(ann, deals, 'd1', { [squad]: [A] })
    const { data } = await load(ann, deals)
    const now = data.tasks.d1
    const forged = { ...now, title: 'Renamed', custom: { [squad]: [A, C] }, version: now.version + 1 }
    const r = await mutate(ann, deals, { type: 'records.restore', changes: [{ entity: 'task', id: 'd1', before: now, after: forged }] })
    expect(r.status).toBe(200)
    expect((await row(deals, 'd1')).custom).toEqual({ [squad]: [A] })
    expect((await load(ann, deals)).data.tasks.d1.title).toBe('Renamed')
  })
})

describe('someone leaves', () => {
  it('a workspace: they’re taken off their cards and out of person fields, hidden ones too, and nothing brings them back', async () => {
    const { ann, ws, deals, reviewer, squad, A, B } = await team()
    await set(ann, deals, 'd1', { [reviewer]: [B], [squad]: [A, B] })
    await mutate(ann, deals, { type: 'task.update', id: 'd1', fields: { assigneeId: B } })
    await set(ann, deals, 'd2', { [squad]: [B] })
    // Team is taken off the board: its values stay on the cards, unseen.
    await pick(ann, deals, [{ id: reviewer }])
    await ann.ok('DELETE', `/api/workspaces/${ws}/members/${B}`)
    expect(await row(deals, 'd1')).toEqual({ assigneeId: null, custom: { [squad]: [A] } })
    expect((await row(deals, 'd2')).custom).toBeNull()
    // The next edit of the card starts from what's stored now, not from a copy made before they left.
    expect((await mutate(ann, deals, { type: 'task.update', id: 'd1', fields: { title: 'Site' } })).status).toBe(200)
    expect(await row(deals, 'd1')).toEqual({ assigneeId: null, custom: { [squad]: [A] } })
    await pick(ann, deals, [{ id: reviewer }, { id: squad }])
    expect((await load(ann, deals)).data.tasks.d1.custom).toEqual({ [squad]: [A] })
  })

  it('a board’s own list, but is still there through the workspace: their cards stay theirs', async () => {
    const { ann, bob, deals, reviewer, B } = await team()
    await ann.ok('POST', `/api/boards/${deals}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await set(ann, deals, 'd1', { [reviewer]: [B] })
    await mutate(ann, deals, { type: 'task.update', id: 'd1', fields: { assigneeId: B } })
    await ann.ok('DELETE', `/api/boards/${deals}/members/${B}`)
    expect(await row(deals, 'd1')).toEqual({ assigneeId: B, custom: { [reviewer]: [B] } })
    expect((await load(bob, deals)).data.members.map((m: { name: string }) => m.name)).toContain('Bob')
    // Once the board closes to the workspace and they're taken off it, they go.
    await ann.ok('POST', `/api/boards/${deals}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await ann.ok('PATCH', `/api/boards/${deals}/sharing`, { visibility: 'invited' })
    await ann.ok('DELETE', `/api/boards/${deals}/members/${B}`)
    expect(await row(deals, 'd1')).toEqual({ assigneeId: null, custom: null })
  })
})

describe('people and other boards', () => {
  it('a card moving to a board keeps the people who are on it, and the move says who stays behind', async () => {
    const { ann, deals, reviewer, squad, board, A, B } = await team()
    const other = await board('Private')
    await ann.ok('PATCH', `/api/boards/${other}/sharing`, { visibility: 'invited' })
    await pick(ann, other, [{ id: reviewer }, { id: squad }])
    await set(ann, deals, 'd1', { [reviewer]: [B], [squad]: [A, B] })
    const moved = await ann.ok('POST', `/api/boards/${deals}/tasks/d1/move`, { boardId: other })
    expect(moved.summary.leftBehind).toEqual(['Bob'])
    expect(moved.summary.droppedFields).toEqual([])
    expect((await row(other, moved.id)).custom).toEqual({ [squad]: [A] })
  })

  it('a board leaving the workspace keeps the people it still has', async () => {
    const { ann, deals, squad, A, B } = await team()
    await set(ann, deals, 'd1', { [squad]: [A, B] })
    await ann.ok('PUT', `/api/boards/${deals}/workspace`, { workspaceId: null, confirm: true })
    const { data } = await load(ann, deals)
    const mine = data.fields.find((f: { name: string }) => f.name === 'Team')
    expect(mine).toMatchObject({ type: 'person', many: true })
    expect(data.tasks.d1.custom).toEqual({ [mine.id]: [A] })
  })

  it('an imported board keeps only the person importing it', async () => {
    const { ann, bob, deals, reviewer, squad, A, B } = await team()
    await set(ann, deals, 'd1', { [reviewer]: [A], [squad]: [A, B] })
    const file = { app: 'kanbanto', format: 3, data: (await ann.ok('GET', `/api/boards/${deals}?archived=all`)).data }
    const copy = await bob.ok('POST', '/api/boards/import', { file })
    const { data } = await load(bob, copy.id)
    const his = data.fields.find((f: { name: string }) => f.name === 'Team')
    expect(data.tasks.d1.custom).toEqual({ [his.id]: [B] })
  })
})

describe('finding cards by a person', () => {
  it('Search cards: mine, someone’s, no one’s, and the names in what a card says', async () => {
    const { ann, bob, deals, reviewer, A, B } = await team()
    await set(ann, deals, 'd1', { [reviewer]: [B] })
    const search = (p: Person, fv: string) => p.ok('GET', `/api/cards?state=active&board=${deals}&field=${reviewer}&fv=${fv}`)
    expect((await search(bob, 'me')).cards.map((c: { id: string }) => c.id)).toEqual(['d1'])
    expect((await search(ann, 'me')).total).toBe(0)
    expect((await search(ann, 'any')).cards[0].field).toEqual({ name: 'Reviewer', text: 'Bob' })
    expect((await search(ann, 'none')).cards.map((c: { id: string }) => c.id)).toEqual(['d2'])
    expect((await search(ann, `${A},${B}`)).total).toBe(1)
    expect((await search(ann, '-')).total).toBe(1)
  })
})
