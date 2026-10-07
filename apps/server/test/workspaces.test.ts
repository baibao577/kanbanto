import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attachments } from '../src/db/schema'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const open = (p: Person, id: string) => p.request('GET', `/api/boards/${id}`)
const mutate = (p: Person, id: string, command: object) => p.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const boardIds = async (p: Person) => (await p.ok('GET', '/api/boards')).boards.map((b: { id: string }) => b.id)

/** Ann (admin) made the workspace "Acme" and a board in it; Bob is in Acme too. Carl isn't. */
async function acme() {
  const ann = await Person.signUp(t.app, 'Ann')
  const bob = await Person.signUp(t.app, 'Bob')
  const carl = await Person.signUp(t.app, 'Carl')
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  // The site doesn't send email here, so someone with an account is added straight away.
  expect(await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })).toMatchObject({ outcome: 'added', name: 'Bob' })
  const { id: board } = await ann.ok('POST', '/api/boards', { name: 'Launch', template: 'example', workspaceId: ws })
  return { ann, bob, carl, ws, board }
}

describe('workspaces', () => {
  it('a board in a workspace opens for everyone in it (as editors), and for nobody else', async () => {
    const { ann, bob, carl, ws, board } = await acme()
    expect((await ann.ok('GET', '/api/workspaces')).workspaces).toEqual([{ id: ws, name: 'Acme', role: 'admin', memberCount: 2 }])
    expect((await bob.ok('GET', '/api/workspaces')).workspaces[0]).toMatchObject({ role: 'member' })

    const listed = (await bob.ok('GET', '/api/boards')).boards.find((b: { id: string }) => b.id === board)
    expect(listed).toMatchObject({ workspaceId: ws, visibility: 'workspace', role: 'editor' })
    const snap = (await open(bob, board)).body
    expect(snap.access).toEqual({
      role: 'editor',
      via: 'workspace',
      visibility: 'workspace',
      publicLink: false,
      workspace: { id: ws, name: 'Acme' },
      archivedAt: null,
      inbox: false,
    })
    expect((await mutate(bob, board, { type: 'task.update', id: 'A', fields: { title: 'Go live' } })).status).toBe(200)
    // Everyone in the workspace can be assigned and @mentioned.
    expect(snap.data.members.map((m: { name: string }) => m.name)).toEqual(['Ann', 'Bob'])

    expect((await open(carl, board)).status).toBe(404)
    expect(await boardIds(carl)).not.toContain(board)
    expect((await carl.request('GET', `/api/workspaces/${ws}`)).status).toBe(404)
  })

  it('the board decides: workspace members can be viewers; people added keep the higher role', async () => {
    const { ann, bob, board } = await acme()
    await ann.ok('PATCH', `/api/boards/${board}/sharing`, { workspaceRole: 'viewer' })
    expect((await open(bob, board)).body.access).toMatchObject({ role: 'viewer', via: 'workspace' })
    expect((await mutate(bob, board, { type: 'task.delete', id: 'A' })).status).toBe(403)
    await ann.ok('POST', `/api/boards/${board}/invitations`, { email: 'bob@example.com', role: 'editor' })
    expect((await open(bob, board)).body.access).toMatchObject({ role: 'editor', via: 'member' })
  })

  it('only people added, and private: the workspace alone doesn’t get in (its admins neither)', async () => {
    const { ann, bob, carl, board } = await acme()
    await ann.ok('PATCH', `/api/boards/${board}/sharing`, { visibility: 'invited' })
    expect((await open(bob, board)).status).toBe(404)
    expect(await boardIds(bob)).not.toContain(board)
    await ann.ok('POST', `/api/boards/${board}/invitations`, { email: 'carl@example.com', role: 'viewer' })
    expect((await open(carl, board)).body.access).toMatchObject({ role: 'viewer', via: 'member' })

    // Bob's private board: Ann is the workspace's admin, but it isn't hers to see.
    const ws = (await bob.ok('GET', '/api/workspaces')).workspaces[0].id
    const { id: mine } = await bob.ok('POST', '/api/boards', { name: 'Notes', workspaceId: ws })
    await bob.ok('PATCH', `/api/boards/${mine}/sharing`, { visibility: 'private', publicLink: true })
    expect((await open(ann, mine)).status).toBe(404)
    expect(await boardIds(ann)).not.toContain(mine)
    // Private wins over the public link.
    expect((await open(new Person(t.app), mine)).status).toBe(401)
  })

  it('the public link works on top of any setting', async () => {
    const { ann, board } = await acme()
    await ann.ok('PATCH', `/api/boards/${board}/sharing`, { publicLink: true })
    const anon = new Person(t.app)
    const snap = (await open(anon, board)).body
    // Visitors aren't told which workspace it's in.
    expect(snap.access).toMatchObject({ role: 'viewer', via: 'public', workspace: null })
    expect((await anon.request('GET', `/api/boards/${board}/sharing`)).status).toBe(401)
  })

  it('sharing with the workspace needs the board to be in one', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    expect((await ann.request('PATCH', `/api/boards/${id}/sharing`, { visibility: 'workspace' })).status).toBe(400)
  })

  it('joining with the invite link, signing up or signed in; the link can be replaced', async () => {
    const { ann, carl, ws, board } = await acme()
    const { link } = await ann.ok('PUT', `/api/workspaces/${ws}/invites/link`, {})
    const preview = await new Person(t.app).ok('GET', `/api/invites/${link.token}`)
    expect(preview).toEqual({ kind: 'workspace', workspace: { id: ws, name: 'Acme' }, email: null })

    const dan = await Person.signUp(t.app, 'Dan', { invite: link.token })
    expect((await open(dan, board)).body.access.role).toBe('editor')
    // People who join a workspace don't get the example board.
    expect(await boardIds(dan)).toEqual([board])

    expect(await carl.ok('POST', '/api/join', { invite: link.token })).toEqual({ kind: 'workspace', workspaceId: ws })
    expect((await ann.ok('GET', `/api/workspaces/${ws}`)).members.map((m: { name: string }) => m.name)).toEqual(['Ann', 'Bob', 'Carl', 'Dan'])

    const replaced = await ann.ok('PUT', `/api/workspaces/${ws}/invites/link`, { regenerate: true })
    expect(replaced.link.token).not.toBe(link.token)
    expect((await new Person(t.app).request('GET', `/api/invites/${link.token}`)).status).toBe(404)
  })

  it('people added to a workspace or a board are told under the bell', async () => {
    const { ann, bob, carl, ws, board } = await acme()
    await ann.ok('POST', `/api/boards/${board}/invitations`, { email: 'carl@example.com', role: 'viewer' })
    const bell = async (p: Person) => (await p.ok('GET', '/api/notifications')).notifications
    expect(await bell(bob)).toEqual([
      expect.objectContaining({ kind: 'added', actor: 'Ann', workspace: { id: ws, name: 'Acme' }, board: null, read: false }),
    ])
    expect(await bell(carl)).toEqual([
      expect.objectContaining({ kind: 'added', actor: 'Ann', board: { id: board, name: 'Launch' }, workspace: null }),
    ])
    expect((await carl.ok('GET', '/api/notifications')).unread).toBe(1)
  })

  it('only admins manage people; members see names but not addresses', async () => {
    const { ann, bob, carl, ws } = await acme()
    expect((await bob.request('POST', `/api/workspaces/${ws}/invitations`, { email: 'carl@example.com' })).status).toBe(403)
    expect((await bob.request('PUT', `/api/workspaces/${ws}/invites/link`, {})).status).toBe(403)
    const seen = await bob.ok('GET', `/api/workspaces/${ws}`)
    expect(seen.members).toEqual([
      { userId: ann.user.id, name: 'Ann', picture: null, role: 'admin', planner: false },
      { userId: bob.user.id, name: 'Bob', picture: null, email: 'bob@example.com', role: 'member', planner: false },
    ])
    expect(seen.link).toBeNull()
    expect((await ann.request('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })).status).toBe(409)
    await ann.ok('PATCH', `/api/workspaces/${ws}/members/${bob.user.id}`, { role: 'admin' })
    await bob.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'carl@example.com' })
    expect((await carl.ok('GET', '/api/workspaces')).workspaces).toHaveLength(1)
  })

  it('leaving: boards stay in the workspace (an admin takes over), and access ends', async () => {
    const { ann, bob, ws, board } = await acme()
    // Bob made a board in Acme, and has a card on Ann's.
    const { id: bobs } = await bob.ok('POST', '/api/boards', { name: 'Bob’s plan', workspaceId: ws })
    await mutate(ann, board, { type: 'task.update', id: 'A3', fields: { assigneeId: bob.user.id } })

    await bob.ok('DELETE', `/api/workspaces/${ws}/members/${bob.user.id}`)
    expect((await open(bob, board)).status).toBe(404)
    expect((await open(bob, bobs)).status).toBe(404)
    // Ann owns Bob's board now; it's still in Acme.
    const listed = (await ann.ok('GET', '/api/boards')).boards.find((b: { id: string }) => b.id === bobs)
    expect(listed).toMatchObject({ role: 'owner', workspaceId: ws })
    // Bob's card on Ann's board isn't his any more.
    expect((await open(ann, board)).body.data.tasks.A3.assigneeId).toBeUndefined()
  })

  it('an admin removing someone takes over their boards; the last admin can’t leave while others are in', async () => {
    const { ann, bob, ws } = await acme()
    const { id: bobs } = await bob.ok('POST', '/api/boards', { name: 'Bob’s plan', workspaceId: ws })
    expect((await ann.request('DELETE', `/api/workspaces/${ws}/members/${ann.user.id}`)).status).toBe(400)
    await ann.ok('DELETE', `/api/workspaces/${ws}/members/${bob.user.id}`)
    expect((await open(ann, bobs)).body.access.role).toBe('owner')
    expect((await bob.ok('GET', '/api/workspaces')).workspaces).toEqual([])
  })

  it('moving boards: in by their owner, out only by the workspace’s admins', async () => {
    const { ann, bob, carl, ws, board } = await acme()
    // Bob moves his Personal board into Acme: it keeps its sharing (only the people added) until he changes it.
    const [{ id: personal }] = (await bob.ok('GET', '/api/boards')).boards.filter((b: { workspaceId: string | null }) => !b.workspaceId)
    expect(await bob.ok('PUT', `/api/boards/${personal}/workspace`, { workspaceId: ws })).toEqual({ workspaceId: ws, visibility: 'invited' })
    expect((await open(ann, personal)).status).toBe(404)
    await bob.ok('PATCH', `/api/boards/${personal}/sharing`, { visibility: 'workspace' })
    expect((await open(ann, personal)).body.access.role).toBe('editor')
    // Taking it back out needs an admin, even for its owner.
    expect((await bob.request('PUT', `/api/boards/${personal}/workspace`, { workspaceId: null })).status).toBe(403)
    // Nobody moves boards into a workspace they're not in.
    const [{ id: carls }] = (await carl.ok('GET', '/api/boards')).boards
    expect((await carl.request('PUT', `/api/boards/${carls}/workspace`, { workspaceId: ws })).status).toBe(403)

    // Ann (admin and owner) takes her board to Personal: shared with the workspace becomes "people added".
    expect(await ann.ok('PUT', `/api/boards/${board}/workspace`, { workspaceId: null })).toEqual({ workspaceId: null, visibility: 'invited' })
    expect((await open(bob, board)).status).toBe(404)
  })

  it('files on a workspace’s boards count against the workspace, and follow the board when it moves', async () => {
    const { ann, ws, board } = await acme()
    const up = await ann.request('POST', `/api/boards/${board}/tasks/A1/attachments`, Buffer.from('hello'), {
      'content-type': 'application/octet-stream',
      'x-file-name': 'a.txt',
      'x-file-type': 'text/plain',
    })
    expect(up.status).toBe(200)
    const row = async () => (await t.db.select().from(attachments).where(eq(attachments.id, up.body.attachment.id)))[0]
    expect(await row()).toMatchObject({ workspaceId: ws, ownerId: null })
    await ann.ok('PUT', `/api/boards/${board}/workspace`, { workspaceId: null })
    expect(await row()).toMatchObject({ workspaceId: null, ownerId: ann.user.id })
  })

  it('a workspace can be deleted once its boards are moved out or deleted', async () => {
    const { ann, bob, ws, board } = await acme()
    expect((await bob.request('DELETE', `/api/workspaces/${ws}`)).status).toBe(403)
    expect((await ann.request('DELETE', `/api/workspaces/${ws}`)).status).toBe(400)
    await ann.ok('DELETE', `/api/boards/${board}`)
    await ann.ok('DELETE', `/api/workspaces/${ws}`)
    expect((await bob.ok('GET', '/api/workspaces')).workspaces).toEqual([])
  })
})
