import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boards, users } from '../src/db/schema'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const add = (p: Person, board: string, id: string, title: string, parentId: string | null = null) =>
  p.ok('POST', `/api/boards/${board}/mutations`, { mutationId: mid(), command: { type: 'task.create', id, parentId, fields: { title } } })

describe('the Inbox', () => {
  it('is made the first time it’s asked for: one per person, private, with plain lists', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    // Looking doesn't make one.
    expect(await ann.ok('GET', '/api/inbox')).toEqual({ boardId: null, open: 0 })
    expect((await ann.ok('GET', '/api/boards')).boards).toHaveLength(1)

    // Asking for it does; asking again (even twice at once) gives the same board.
    const [a, b] = await Promise.all([ann.ok('POST', '/api/inbox'), ann.ok('POST', '/api/inbox')])
    expect(a.boardId).toBe(b.boardId)
    expect(await ann.ok('POST', '/api/inbox')).toEqual({ boardId: a.boardId, open: 0 })
    expect(await t.db.select({ id: boards.id }).from(boards).where(eq(boards.inboxOf, ann.user.id))).toHaveLength(1)

    const inbox = a.boardId as string
    const board = await ann.ok('GET', `/api/boards/${inbox}`)
    expect(board.access).toMatchObject({ role: 'owner', visibility: 'private', publicLink: false, workspace: null, inbox: true })
    expect(board.data.board).toMatchObject({ name: 'Inbox', mode: 'manual' })
    expect(board.data.columns.map((c: { name: string }) => c.name)).toEqual(['To Do', 'Doing', 'Done'])
    const listed = (await ann.ok('GET', '/api/boards')).boards
    expect(listed.map((x: { id: string; inbox: boolean }) => [x.id === inbox, x.inbox])).toEqual(
      expect.arrayContaining([
        [true, true],
        [false, false],
      ]),
    )

    // Nobody else can open it, and theirs is another board.
    expect((await bob.request('GET', `/api/boards/${inbox}`)).status).toBe(404)
    expect((await bob.ok('POST', '/api/inbox')).boardId).not.toBe(inbox)
    expect((await new Person(t.app).request('GET', '/api/inbox')).status).toBe(401)
  })

  it('counts the cards that aren’t done', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    await add(ann, inbox, 'bank', 'Call the bank')
    await add(ann, inbox, 'passport', 'Renew passport')
    // A subtask isn't a card of its own.
    await add(ann, inbox, 'old', 'Find the old one', 'passport')
    expect((await ann.ok('GET', '/api/inbox')).open).toBe(2)
    await ann.ok('POST', `/api/boards/${inbox}/mutations`, { mutationId: mid(), command: { type: 'task.move', id: 'passport', status: 'done' } })
    expect(await ann.ok('GET', '/api/inbox')).toEqual({ boardId: inbox, open: 1 })
  })

  it('stays yours alone: no sharing, moving, archiving, deleting or leaving', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    const refused = async (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
      const r = await ann.request(method, `/api/boards/${inbox}${url}`, body)
      expect([method, url, r.status, r.body.code]).toEqual([method, url, 400, 'inbox'])
      return r.body.error as string
    }
    expect(await refused('PATCH', '/sharing', { visibility: 'invited' })).toContain('can’t be shared')
    await refused('PATCH', '/sharing', { publicLink: true })
    await refused('PUT', '/invites/link', { role: 'editor' })
    await refused('PUT', '/invites/code', { role: 'viewer' })
    await refused('POST', '/invitations', { email: 'bob@example.com', role: 'editor' })
    await refused('POST', '/invitations', { email: 'new@example.com', role: 'viewer' })
    expect(await refused('PATCH', `/members/${ann.user.id}`, { role: 'editor' })).toContain('yours alone')
    expect(await refused('DELETE', `/members/${ann.user.id}`)).toContain('can’t be left')
    expect(await refused('PUT', '/workspace', { workspaceId: ws })).toContain('can’t be moved')
    expect(await refused('POST', '/archive', { archived: true })).toContain('can’t be archived')
    expect(await refused('DELETE', '')).toContain('can’t be deleted')

    // It's still a board: its lists, its name and what it's for can change, and it can be a favourite.
    const change = (command: object) => ann.ok('POST', `/api/boards/${inbox}/mutations`, { mutationId: mid(), command })
    await change({ type: 'board.update', fields: { name: 'Braindump', description: 'Things to sort' } })
    await ann.ok('PUT', `/api/boards/${inbox}/favorite`, { favorite: true })
    const after = await ann.ok('GET', `/api/boards/${inbox}`)
    expect(after.data.board.name).toBe('Braindump')
    expect(after.access).toMatchObject({ visibility: 'private', publicLink: false, workspace: null, archivedAt: null, inbox: true })
    expect((await ann.ok('GET', `/api/boards/${inbox}/sharing`)).members).toHaveLength(1)
    // Ordinary boards are as before.
    const [{ id: other }] = (await ann.ok('GET', '/api/boards')).boards.filter((b: { inbox: boolean }) => !b.inbox)
    await ann.ok('POST', `/api/boards/${other}/archive`, { archived: true })
    await ann.ok('DELETE', `/api/boards/${other}`)
  })

  it('with an API token: read it, and make it only with a token that can change things', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    const token = async (scope: 'read' | 'write') =>
      (await ann.ok('POST', '/api/account/tokens', { name: scope, scope, expiresInDays: null })).token as string
    const as = (tok: string, method: 'GET' | 'POST') => new Person(t.app).request(method, '/api/inbox', undefined, { authorization: `Bearer ${tok}` })
    const reader = await token('read')
    expect((await as(reader, 'GET')).body).toEqual({ boardId: null, open: 0 })
    expect((await as(reader, 'POST')).status).toBe(403)
    const made = await as(await token('write'), 'POST')
    expect(made.body.boardId).toEqual(expect.any(String))
    expect((await as(reader, 'GET')).body.boardId).toBe(made.body.boardId)
  })
})

describe('the board someone had chosen as their Inbox (migration 0034)', () => {
  // The statements of the migration that work on existing rows: everything after the ones that change the tables.
  const backfill = readFileSync(new URL('../drizzle/0034_inbox.sql', import.meta.url), 'utf8')
    .split('--> statement-breakpoint')
    .filter((s) => /^\s*(--[^\n]*\n\s*)*UPDATE/.test(s))
  const point = (who: Person, board: string) => t.db.execute(sql`update users set inbox_board_id = ${board} where id = ${who.user.id}`)
  const run = async () => {
    for (const statement of backfill) await t.db.execute(sql.raw(statement))
  }
  const state = async (who: Person, board: string) => {
    const [b] = await t.db.select().from(boards).where(eq(boards.id, board))
    const [u] = await t.db.select().from(users).where(eq(users.id, who.user.id))
    return { inbox: b.inboxOf === who.user.id, visibility: b.visibility, pointer: u.inboxBoardId }
  }
  const firstBoard = async (p: Person) => (await p.ok('GET', '/api/boards')).boards[0].id as string

  it('becomes their Inbox when it was already theirs alone, keeping its cards', async () => {
    expect(backfill).toHaveLength(2)
    const ann = await Person.signUp(t.app, 'Ann')
    const board = await firstBoard(ann)
    await point(ann, board)
    await run()
    expect(await state(ann, board)).toEqual({ inbox: true, visibility: 'private', pointer: board })
    expect(await ann.ok('GET', '/api/inbox')).toMatchObject({ boardId: board })
    // The same board, so asking for the Inbox makes no second one; and its cards are where they were.
    expect((await ann.ok('POST', '/api/inbox')).boardId).toBe(board)
    expect(Object.keys((await ann.ok('GET', `/api/boards/${board}`)).data.tasks).length).toBeGreaterThan(0)
    // Run again (it never is, but): nothing changes.
    await run()
    expect(await state(ann, board)).toEqual({ inbox: true, visibility: 'private', pointer: board })
  })

  it('stays an ordinary board when anyone else can reach it: then they get a new Inbox', async () => {
    const bob = await Person.signUp(t.app, 'Bob')
    const person = async (name: string, prepare: (p: Person, board: string) => Promise<unknown>) => {
      const p = await Person.signUp(t.app, name)
      const board = await firstBoard(p)
      await prepare(p, board)
      await point(p, board)
      return { p, board }
    }
    const cases = [
      await person('Shared', (p, b) => p.ok('POST', `/api/boards/${b}/invitations`, { email: 'bob@example.com', role: 'viewer' })),
      await person('Linked', (p, b) => p.ok('PUT', `/api/boards/${b}/invites/link`, { role: 'viewer' })),
      await person('Coded', (p, b) => p.ok('PUT', `/api/boards/${b}/invites/code`, { role: 'editor' })),
      await person('Invited', (p, b) => p.ok('POST', `/api/boards/${b}/invitations`, { email: 'someone@example.com', role: 'viewer' })),
      await person('Public', (p, b) => p.ok('PATCH', `/api/boards/${b}/sharing`, { publicLink: true })),
      await person('Archived', (p, b) => p.ok('POST', `/api/boards/${b}/archive`, { archived: true })),
      await person('Team', async (p, b) => {
        const { id: ws } = await p.ok('POST', '/api/workspaces', { name: 'Acme' })
        await p.ok('PUT', `/api/boards/${b}/workspace`, { workspaceId: ws })
      }),
    ]
    // Someone whose Inbox was a board of somebody else's.
    const guest = await Person.signUp(t.app, 'Guest')
    await point(guest, cases[0].board)
    // A link that was turned off again no longer counts.
    const once = await person('Once', async (p, b) => {
      await p.ok('PUT', `/api/boards/${b}/invites/link`, { role: 'viewer' })
      await p.ok('DELETE', `/api/boards/${b}/invites/link`)
    })
    await run()
    for (const { p, board } of cases) {
      expect([p.user.name, await state(p, board)]).toEqual([p.user.name, expect.objectContaining({ inbox: false, pointer: null })])
      const made = (await p.ok('POST', '/api/inbox')).boardId
      expect(made).not.toBe(board)
    }
    expect((await state(cases[0].p, cases[0].board)).visibility).toBe('invited')
    expect((await state(guest, cases[0].board)).pointer).toBe(null)
    expect(await state(once.p, once.board)).toMatchObject({ inbox: true, visibility: 'private' })
    expect((await bob.ok('GET', '/api/boards')).boards.some((b: { id: string }) => b.id === cases[0].board)).toBe(true)
  })
})
