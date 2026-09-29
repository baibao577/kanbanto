import { applyChanges, invertChanges } from '@kanbanto/model/changes'
import type { BoardData } from '@kanbanto/model/types'
import { exportFile } from '@kanbanto/model/transfer'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok<{ data: BoardData; seq: number; access: { role: string } }>('GET', `/api/boards/${id}`)
const mutate = (p: Person, id: string, command: unknown, mutationId = mid()) =>
  p.request('POST', `/api/boards/${id}/mutations`, { mutationId, command })

describe('boards', () => {
  it('a new account starts with the example board, assigned to them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { boards } = await ann.ok('GET', '/api/boards')
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({ name: 'My first board', role: 'owner', visibility: 'invited' })
    expect(boards[0].taskCount).toBeGreaterThan(5)
    const { data, access } = await load(ann, boards[0].id)
    expect(access.role).toBe('owner')
    expect(data.members.map((m) => m.name)).toEqual(['Ann'])
    const assignees = new Set(
      Object.values(data.tasks)
        .map((x) => x.assigneeId)
        .filter(Boolean),
    )
    expect([...assignees]).toEqual([ann.user.id])
  })

  it('runs commands with the shared rules, saves them, and counts changes', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Plan', background: 'pink' })
    const before = await load(ann, id)
    expect(before.data.columns.map((c) => c.name)).toEqual(['Backlog', 'To Do', 'Doing', 'Done'])
    const r = await mutate(ann, id, { type: 'task.create', id: 't1', parentId: null, fields: { title: 'Write brief', due: '2026-10-01' } })
    expect(r.status).toBe(200)
    expect(r.body.seq).toBe(before.seq + 1)
    await mutate(ann, id, { type: 'task.create', id: 't2', parentId: 't1', fields: { title: 'Outline' } })
    // The rules are the model's: no loops.
    const loop = await mutate(ann, id, { type: 'task.move', id: 't1', parentId: 't2' })
    expect(loop.status).toBe(422)
    expect(loop.body.error).toMatch(/own subtasks/)
    // Saved in the database (not just the server's memory).
    t.app.engine.forget(id)
    const after = await load(ann, id)
    expect(after.data.tasks.t1).toMatchObject({ title: 'Write brief', due: '2026-10-01', parentId: null })
    expect(after.data.tasks.t2.parentId).toBe('t1')
    expect(after.data.board.background).toBe('pink')
  })

  it('a retried request runs once', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Plan' })
    const cmd = { type: 'column.create', name: 'Review', category: 'doing' }
    const a = await mutate(ann, id, cmd, 'same-id')
    const b = await mutate(ann, id, cmd, 'same-id')
    expect(b.body).toEqual(a.body)
    expect((await load(ann, id)).data.columns.filter((c) => c.name === 'Review')).toHaveLength(1)
  })

  it('undo goes through the server too, and is refused over someone else’s newer edit', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const start = (await load(ann, id)).data
    const del = await mutate(ann, id, { type: 'task.delete', id: 'A2' })
    const now = applyChanges(start, del.body.changes)
    const undo = await mutate(ann, id, { type: 'records.restore', changes: invertChanges(now, del.body.changes, new Date().toISOString()) })
    expect(undo.status).toBe(200)
    expect(Object.keys((await load(ann, id)).data.tasks).sort()).toEqual(Object.keys(start.tasks).sort())

    const rename = await mutate(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship' } })
    const cur = (await load(ann, id)).data
    const stale = invertChanges(cur, rename.body.changes, new Date().toISOString())
    await mutate(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    const refused = await mutate(ann, id, { type: 'records.restore', changes: stale })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toMatch(/in the meantime/)
  })

  it('rejects malformed commands before running them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    expect((await mutate(ann, id, { type: 'task.update', id: 'A', fields: { due: 'soon' } })).status).toBe(400)
    expect((await mutate(ann, id, { type: 'drop.tables' })).status).toBe(400)
    // PostgreSQL text can't hold NUL: refused up front, not a server error.
    expect((await mutate(ann, id, { type: 'task.create', parentId: null, fields: { title: 'a\u0000b' } })).status).toBe(400)
    expect((await mutate(ann, id, { type: 'board.update', fields: { name: 'x\u0000' } })).status).toBe(400)
    expect((await ann.request('POST', '/api/boards', { name: 'x\u0000' })).status).toBe(400)
  })

  it('undo can’t put back records no command could have made (which would break the board for everyone)', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const { data } = await load(ann, id)
    const task = data.tasks.A3
    const restore = (after: object) =>
      mutate(ann, id, { type: 'records.restore', changes: [{ entity: 'task', id: 'A3', before: task, after: { ...task, ...after } }] })
    // An order that isn't a real position would make every later insert fail.
    expect((await restore({ order: '~~~' })).status).toBe(400)
    expect((await restore({ rank: 'a0 ' })).status).toBe(400)
    expect((await restore({ title: 'x'.repeat(501) })).status).toBe(400)
    const board = await mutate(ann, id, {
      type: 'records.restore',
      changes: [{ entity: 'board', id, before: data.board, after: { ...data.board, name: 'x'.repeat(5000) } }],
    })
    expect(board.status).toBe(400)
    // The board still works.
    expect((await mutate(ann, id, { type: 'task.create', parentId: null, fields: { title: 'Still fine' } })).status).toBe(200)
  })

  it('a retried mutation id from someone else runs as their own command', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'editor' })
    const bob = await Person.signUp(t.app, 'Bob')
    await bob.ok('POST', '/api/join', { invite: link.token })
    const shared = mid()
    await mutate(ann, id, { type: 'task.update', id: 'A', fields: { title: 'Ann’s' } }, shared)
    const bobs = await mutate(bob, id, { type: 'task.update', id: 'A', fields: { title: 'Bob’s' } }, shared)
    expect(bobs.body.changes[0]).toMatchObject({ after: { title: 'Bob’s' } })
  })

  it('imports an export as a new board', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const { data } = await load(ann, id)
    const copy = await ann.ok('POST', '/api/boards/import', { file: exportFile({ ...data, board: { ...data.board, name: 'Copy' } }) })
    const imported = await load(ann, copy.id)
    expect(imported.data.board.name).toBe('Copy')
    expect(Object.keys(imported.data.tasks)).toHaveLength(Object.keys(data.tasks).length)
    expect((await ann.request('POST', '/api/boards/import', { file: { hello: 1 } })).body.error).toMatch(/isn’t a board/)
  })

  it('only owners delete boards', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const bob = await Person.signUp(t.app, 'Bob')
    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'editor' })
    await bob.ok('POST', '/api/join', { invite: link.token })
    expect((await bob.request('DELETE', `/api/boards/${id}`)).status).toBe(403)
    await ann.ok('DELETE', `/api/boards/${id}`)
    expect((await ann.request('GET', `/api/boards/${id}`)).status).toBe(404)
  })
})

describe('sharing', () => {
  /** Ann and her board, plus Bob. */
  async function annAndBoard() {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const bob = await Person.signUp(t.app, 'Bob')
    return { ann, bob, id }
  }

  it('strangers can’t see a board; signed-out people are asked to sign in', async () => {
    const { bob, id } = await annAndBoard()
    expect((await bob.request('GET', `/api/boards/${id}`)).status).toBe(404)
    expect((await new Person(t.app).request('GET', `/api/boards/${id}`)).status).toBe(401)
    expect((await bob.ok('GET', '/api/boards')).boards.some((b: { id: string }) => b.id === id)).toBe(false)
  })

  it('a share link adds people with its role; viewers can’t edit', async () => {
    const { ann, bob, id } = await annAndBoard()
    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'viewer' })
    const preview = await new Person(t.app).ok('GET', `/api/invites/${link.token}`)
    expect(preview).toMatchObject({ role: 'viewer', board: { id } })
    await bob.ok('POST', '/api/join', { invite: link.token })
    expect((await load(bob, id)).access.role).toBe('viewer')
    const edit = await mutate(bob, id, { type: 'task.update', id: 'A', fields: { title: 'Mine now' } })
    expect(edit.status).toBe(403)
    // Bob is now one of the board's people, so cards can be assigned to him.
    expect((await load(ann, id)).data.members.map((m) => m.name)).toEqual(['Ann', 'Bob'])
    expect((await mutate(ann, id, { type: 'task.update', id: 'A', fields: { assigneeId: bob.user.id } })).status).toBe(200)
  })

  it('access codes work however they’re typed, and can be replaced', async () => {
    const { ann, bob, id } = await annAndBoard()
    const { code } = await ann.ok('PUT', `/api/boards/${id}/invites/code`, { role: 'editor' })
    expect(code.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const replaced = await ann.ok('PUT', `/api/boards/${id}/invites/code`, { role: 'editor', regenerate: true })
    expect((await bob.request('POST', '/api/join', { invite: code.code })).status).toBe(404)
    await bob.ok('POST', '/api/join', { invite: ` ${replaced.code.code.toLowerCase().replace('-', ' ')} ` })
    expect((await load(bob, id)).access.role).toBe('editor')
  })

  it('private boards: only owners get in, and invites wait', async () => {
    const { ann, bob, id } = await annAndBoard()
    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'editor' })
    await bob.ok('POST', '/api/join', { invite: link.token })
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { visibility: 'private' })
    expect((await bob.request('GET', `/api/boards/${id}`)).status).toBe(404)
    const carl = await Person.signUp(t.app, 'Carl')
    expect((await carl.request('POST', '/api/join', { invite: link.token })).status).toBe(403)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { visibility: 'invited' })
    expect((await load(bob, id)).access.role).toBe('editor')
  })

  it('with the public link on, anyone can view a board, even signed out', async () => {
    const { ann, bob, id } = await annAndBoard()
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const anon = new Person(t.app)
    expect((await load(anon, id)).access).toMatchObject({ role: 'viewer', via: 'public' })
    expect((await load(bob, id)).access.role).toBe('viewer')
    expect((await mutate(bob, id, { type: 'task.delete', id: 'A' })).status).toBe(403)
    expect((await anon.request('POST', `/api/boards/${id}/mutations`, { mutationId: 'x', command: { type: 'task.delete', id: 'A' } })).status).toBe(
      401,
    )
  })

  it('who’s on a board: members only; only owners see email addresses', async () => {
    const { ann, bob, id } = await annAndBoard()
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'viewer' })
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    // A stranger visiting the public board doesn't see who's on it.
    const eve = await Person.signUp(t.app, 'Eve')
    expect((await eve.request('GET', `/api/boards/${id}/sharing`)).status).toBe(403)
    // Bob sees names, and only his own address.
    const seen = (await bob.ok('GET', `/api/boards/${id}/sharing`)).members
    expect(seen).toEqual([
      { userId: ann.user.id, name: 'Ann', role: 'owner' },
      { userId: bob.user.id, name: 'Bob', email: 'bob@example.com', role: 'viewer' },
    ])
    // Ann (an owner) sees everyone's.
    expect((await ann.ok('GET', `/api/boards/${id}/sharing`)).members.map((m: { email: string }) => m.email)).toEqual([
      'ann@example.com',
      'bob@example.com',
    ])
  })

  it('adding someone who’s already on the board changes nothing (so it can’t take away the last owner)', async () => {
    const { ann, bob, id } = await annAndBoard()
    expect(await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })).toMatchObject({ outcome: 'added' })
    const again = await ann.request('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'viewer' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('Bob is already on this board (Can edit). Change their role in the list below.')
    expect((await load(bob, id)).access.role).toBe('editor')
    // Ann is the only owner: adding herself as a viewer must not demote her.
    expect((await ann.request('POST', `/api/boards/${id}/invitations`, { email: 'ann@example.com', role: 'viewer' })).status).toBe(409)
    expect((await load(ann, id)).access.role).toBe('owner')
  })

  it('a board always keeps an owner; removing someone unassigns their cards', async () => {
    const { ann, bob, id } = await annAndBoard()
    expect((await ann.request('PATCH', `/api/boards/${id}/members/${ann.user.id}`, { role: 'editor' })).status).toBe(400)
    expect((await ann.request('DELETE', `/api/boards/${id}/members/${ann.user.id}`)).status).toBe(400)
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await mutate(ann, id, { type: 'task.update', id: 'A3', fields: { assigneeId: bob.user.id } })
    // Bob can leave by himself.
    await bob.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    const { data } = await load(ann, id)
    expect(data.tasks.A3.assigneeId).toBeUndefined()
    expect(data.members.map((m) => m.name)).toEqual(['Ann'])
  })

  it('platform admins get no special access to other people’s boards', async () => {
    const { ann, bob, id } = await annAndBoard()
    await setPlatformAdmin(t.db, 'bob@example.com', true)
    expect((await bob.request('GET', `/api/boards/${id}`)).status).toBe(404)
    expect((await bob.ok('GET', '/api/boards')).boards.some((b: { id: string }) => b.id === id)).toBe(false)
    expect((await bob.request('DELETE', `/api/boards/${id}`)).status).toBe(404)
    expect((await ann.ok('GET', `/api/boards/${id}`)).access.role).toBe('owner')
  })
})
