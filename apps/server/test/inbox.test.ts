import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardActivity, boards, tasks, users } from '../src/db/schema'
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

describe('adding a card in one call, with plain names', () => {
  const tasksOf = async (boardId: string) => t.db.select().from(tasks).where(eq(tasks.boardId, boardId))
  const tokenFor = async (p: Person, scope: 'read' | 'write') => {
    const admin = await Person.signUp(t.app, 'Root')
    await setPlatformAdmin(t.db, 'root@example.com', true)
    await admin.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    const token = (await p.ok('POST', '/api/account/tokens', { name: 'script', scope, expiresInDays: null })).token as string
    return (method: 'GET' | 'POST', url: string, body?: unknown) => new Person(t.app).request(method, url, body, { authorization: `Bearer ${token}` })
  }

  it('to your Inbox: made on first use, with a title alone or with what else is said', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    expect(await ann.ok('GET', '/api/inbox')).toEqual({ boardId: null, open: 0 })
    const first = await ann.ok('POST', '/api/inbox/cards', { title: '  Call Sam  ' })
    const { boardId: inbox } = await ann.ok('GET', '/api/inbox')
    expect(first).toMatchObject({ board: { id: inbox, name: 'Inbox', inbox: true }, card: { title: 'Call Sam' } })
    expect(first.card.url).toMatch(new RegExp(`/#/b/${inbox}\\?task=${first.card.id}$`))

    const second = await ann.ok('POST', '/api/inbox/cards', {
      title: 'Plan the trip',
      description: 'Flights first',
      list: 'doing',
      priority: 'high',
      due: '2026-12-01',
      subtasks: [{ title: 'Book flights', due: '2026-11-20' }, { title: 'Find a hotel' }],
    })
    expect(second.card.subtasks.map((s: { title: string }) => s.title)).toEqual(['Book flights', 'Find a hotel'])
    const all = await tasksOf(inbox)
    expect(all.find((c) => c.id === second.card.id)).toMatchObject({
      description: 'Flights first',
      status: 'doing',
      priority: 'high',
      due: '2026-12-01',
    })
    expect(all.find((c) => c.title === 'Book flights')).toMatchObject({ parentId: second.card.id, due: '2026-11-20' })
    // (Two cards wait in the Inbox: a card's subtasks aren't counted apart from it.)
    expect((await ann.ok('GET', '/api/inbox')).open).toBe(2)

    // Nothing it doesn't know is taken quietly, and a card needs a title.
    expect((await ann.request('POST', '/api/inbox/cards', { title: 'x', colour: 'red' })).status).toBe(400)
    expect((await ann.request('POST', '/api/inbox/cards', { title: '   ' })).status).toBe(400)
    expect((await ann.request('POST', '/api/inbox/cards', { title: 'x', parentId: 'A' })).status).toBe(400)
    expect((await new Person(t.app).request('POST', '/api/inbox/cards', { title: 'x' })).status).toBe(401)
  })

  it('to a board: its list, labels, person and fields by name; a wrong name adds nothing and says what there is', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const before = (await tasksOf(id)).length
    const made = await ann.ok('POST', `/api/boards/${id}/cards`, {
      title: 'Fix the sign-up page',
      list: 'Doing',
      labels: ['ui', 'BRAND'],
      assignee: 'me',
      parentId: 'A',
    })
    const [card] = (await tasksOf(id)).filter((c) => c.id === made.card.id)
    expect(card).toMatchObject({ title: 'Fix the sign-up page', status: 'doing', labels: ['ui', 'brand'], assigneeId: ann.user.id, parentId: 'A' })
    expect(made.board).toEqual({ id, name: 'My first board' })

    const wrong = await ann.request('POST', `/api/boards/${id}/cards`, { title: 'Nope', list: 'Later', subtasks: [{ title: 'Nor this' }] })
    expect(wrong).toMatchObject({ status: 400, body: { error: expect.stringMatching(/There’s no list “Later”\. The lists are: .*To Do/) } })
    expect((await ann.request('POST', `/api/boards/${id}/cards`, { title: 'Nope', labels: ['urgent!'] })).status).toBe(400)
    expect((await ann.request('POST', `/api/boards/${id}/cards`, { title: 'Nope', assignee: 'Nobody Here' })).status).toBe(400)
    expect((await ann.request('POST', `/api/boards/${id}/cards`, { title: 'Nope', parentId: 'no-such-card' })).status).toBe(404)
    expect(await tasksOf(id)).toHaveLength(before + 1)

    // Who may: people who can edit the board.
    const bob = await Person.signUp(t.app, 'Bob')
    expect((await bob.request('POST', `/api/boards/${id}/cards`, { title: 'Hello' })).status).toBe(404)
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'viewer' })
    expect((await bob.request('POST', `/api/boards/${id}/cards`, { title: 'Hello' })).status).toBe(403)
  })

  it('a date as a day, a moment or words, read on the person’s clock; a time in the title only when asked', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await ann.ok('PATCH', '/api/auth/me', { timeZone: 'Asia/Bangkok' })
    const due = async (body: object) => {
      const { card, board } = await ann.ok('POST', '/api/inbox/cards', body)
      const [row] = (await tasksOf(board.id)).filter((c) => c.id === card.id)
      return { title: row.title, due: row.due }
    }
    const bangkok = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10)

    expect(await due({ title: 'A day', due: '2026-12-01' })).toEqual({ title: 'A day', due: '2026-12-01' })
    expect((await due({ title: 'A moment', due: '2026-12-01T14:30:00+07:00' })).due).toMatch(/^2026-12-01T07:30:00/)
    // Words: tomorrow at 3pm in Bangkok is 08:00 UTC; a day with no time is the whole day.
    expect((await due({ title: 'Words', due: 'tomorrow 3pm' })).due).toMatch(new RegExp(`^${bangkok(1)}T08:00:00`))
    expect((await due({ title: 'A whole day', due: 'tomorrow' })).due).toBe(bangkok(1))
    // …or where the call says: 3pm in New York.
    expect((await due({ title: 'Elsewhere', due: 'tomorrow 3pm', timeZone: 'America/New_York' })).due).toMatch(/T(19|20):00:00/)
    expect(await ann.request('POST', '/api/inbox/cards', { title: 'x', due: 'whenever' })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/“whenever” isn’t a date I can read/) },
    })
    expect((await ann.request('POST', '/api/inbox/cards', { title: 'x', timeZone: 'Mars/Olympus' })).status).toBe(400)

    // A time in the title stays in the title, unless the call asks for it to be read.
    expect(await due({ title: 'Call Sam tomorrow 3pm' })).toEqual({ title: 'Call Sam tomorrow 3pm', due: null })
    const read = await due({ title: 'Call Sam tomorrow 3pm', datesInTitle: true })
    expect(read.title).toBe('Call Sam')
    expect(read.due).toMatch(new RegExp(`^${bangkok(1)}T08:00:00`))
    // (A date given outright wins.)
    expect(await due({ title: 'Call Sam tomorrow 3pm', datesInTitle: true, due: '2026-12-01' })).toEqual({
      title: 'Call Sam tomorrow 3pm',
      due: '2026-12-01',
    })
  })

  it('with an API token: one that can change things adds, and the board’s activity says it came through the API', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const write = await tokenFor(ann, 'write')
    const made = await write('POST', '/api/inbox/cards', { title: 'From a script' })
    expect(made).toMatchObject({ status: 200, body: { card: { title: 'From a script' }, board: { inbox: true } } })
    const [said] = await t.db.select().from(boardActivity).where(eq(boardActivity.boardId, made.body.board.id))
    expect(said).toMatchObject({ actorId: ann.user.id, command: 'task.create', via: 'API' })
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards.filter((b: { inbox?: boolean }) => !b.inbox)
    expect((await write('POST', `/api/boards/${id}/cards`, { title: 'On the board' })).status).toBe(200)

    const read = (await ann.ok('POST', '/api/account/tokens', { name: 'reader', scope: 'read', expiresInDays: null })).token as string
    expect((await new Person(t.app).request('POST', '/api/inbox/cards', { title: 'x' }, { authorization: `Bearer ${read}` })).status).toBe(403)
  })
})
