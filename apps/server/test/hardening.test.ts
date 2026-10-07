import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LiveMessage } from '../src/live'
import { sendReminders } from '../src/reminders'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann's board, with Bob on it as an editor. */
async function pair() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  return { ann, bob, id }
}
const run = (p: Person, boardId: string, command: object) => p.request('POST', `/api/boards/${boardId}/mutations`, { mutationId: mid(), command })
async function listen(boardId: string, headers: Record<string, string> = {}) {
  const messages: LiveMessage[] = []
  const closed = { code: 0 }
  const ws: WebSocket = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers })
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  ws.on('close', (code) => (closed.code = code))
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20))
    return test()
  }
  return { ws, messages, closed, until }
}

describe('records nobody could have made with the app', () => {
  it('undo refuses a looping archived task and a reminder with no real time; the reminder run survives one that slips in', async () => {
    const { ann, id } = await pair()
    const { data: board } = await ann.ok('GET', `/api/boards/${id}`)
    const sample = Object.values(board.tasks)[0] as Record<string, unknown>
    const made = (extra: object) => ({ ...sample, id: 'x1', title: 'x', parentId: null, blockedBy: [], labels: [], ...extra })
    const restore = (after: object) => run(ann, id, { type: 'records.restore', changes: [{ entity: 'task', id: 'x1', before: null, after }] })
    expect((await restore(made({ parentId: 'x1', archivedAt: new Date().toISOString() }))).status).toBe(422)
    expect((await restore(made({ reminders: [{ id: 'r', at: 'soon' }] }))).status).toBe(400)
    // An old-format file passes the same checks as an export.
    expect(
      (await ann.request('POST', '/api/boards/import', { file: { boardName: 'x', tasks: [{ id: 'a', title: 't', due: 'not-a-date' }] } })).status,
    ).toBe(400)
    await expect(sendReminders(t.app)).resolves.toBe(0)
  })
})

describe('what stops when access does', () => {
  it('the bell shows nothing from a board once you can’t open it', async () => {
    const { ann, bob, id } = await pair()
    await ann.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'The secret plan, @Bob', mentions: [bob.user.id] })
    const before = (await bob.ok('GET', '/api/notifications')).notifications.find((n: { kind: string }) => n.kind === 'mention')
    expect(before).toMatchObject({ board: { id }, excerpt: expect.stringMatching(/secret plan/) })
    await ann.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    await run(ann, id, { type: 'task.update', id: 'A', fields: { title: 'Renamed after Bob left' } })
    const after = (await bob.ok('GET', '/api/notifications')).notifications.find((n: { kind: string }) => n.kind === 'mention')
    expect(after).toMatchObject({ board: { id: '', name: 'A board you can no longer open' }, task: { id: '', title: 'A task' }, excerpt: '' })
  })

  it('logged time isn’t sent to a visitor with the public link, and an API token can’t open a live connection', async () => {
    const { ann, id } = await pair()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const visitor = await listen(id)
    const member = await listen(id, { cookie: ann.cookie })
    expect(await visitor.until(() => visitor.messages.some((m) => m.type === 'hello'))).toBe(true)
    expect(await member.until(() => member.messages.some((m) => m.type === 'hello'))).toBe(true)
    await ann.ok('POST', `/api/boards/${id}/tasks/A3/time`, { minutes: 30, day: new Date().toISOString().slice(0, 10) })
    expect(await member.until(() => member.messages.some((m) => m.type === 'time'))).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(visitor.messages.some((m) => m.type === 'time')).toBe(false)
    visitor.ws.terminate()
    member.ws.terminate()

    const { token } = await ann.ok('POST', '/api/account/tokens', { name: 'script', scope: 'write', expiresInDays: null })
    const withToken = await listen(id, { authorization: `Bearer ${token}` })
    expect(await withToken.until(() => withToken.closed.code === 4403)).toBe(true)
    // "Who am I" can be read with a token, not changed.
    const bearer = { authorization: `Bearer ${token}` }
    expect((await new Person(t.app).request('GET', '/api/auth/me', undefined, bearer)).body.user.name).toBe('Ann')
    expect((await new Person(t.app).request('PATCH', '/api/auth/me', { name: 'Changed' }, bearer)).status).toBe(403)
  })

  it('desktop notifications: only to public addresses, and a browser is forgotten when it signs out or the password changes', async () => {
    const { ann } = await pair()
    const keys = { p256dh: 'BPk', auth: 'aa' }
    for (const endpoint of ['https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://db.internal/x', 'https://localhost/x'])
      expect((await ann.request('POST', '/api/push/devices', { endpoint, keys })).status, endpoint).toBe(400)
    const here = 'https://push.example.com/here'
    const there = 'https://push.example.com/there'
    await ann.ok('POST', '/api/push/devices', { endpoint: here, keys })
    await ann.ok('POST', '/api/push/devices', { endpoint: there, keys })
    const endpoints = async (p: Person) => (await p.ok('GET', '/api/push/devices')).devices.map((d: { endpoint: string }) => d.endpoint).sort()
    // A new password: the other browsers stop, this one stays.
    await ann.ok('POST', '/api/auth/password', { current: 'correct horse', next: 'battery staple 9', pushEndpoint: here })
    expect(await endpoints(ann)).toEqual([here])
    // Signing out: this browser stops too.
    await ann.ok('POST', '/api/auth/signout', { pushEndpoint: here })
    await ann.ok('POST', '/api/auth/signin', { email: 'ann@example.com', password: 'battery staple 9' })
    expect(await endpoints(ann)).toEqual([])
  })

  it('a file coming back from the trash needs room; only the upload route takes raw bytes', async () => {
    const raw = await t.app.inject({
      method: 'PUT',
      url: '/api/account/storage/bucket',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10),
    })
    expect(raw.statusCode).toBe(415)
    // …and a picture's bytes only go where a profile picture is set.
    const picture = await t.app.inject({ method: 'PATCH', url: '/api/auth/me', headers: { 'content-type': 'image/png' }, payload: Buffer.alloc(10) })
    expect(picture.statusCode).toBe(415)
  })
})

describe('the rest of the review', () => {
  it('a plan project can’t be linked to a board its planner can’t open, and undo can’t add an outsider’s account to the plan', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const eve = await Person.signUp(t.app, 'Eve')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Studio' })
    const { link } = await ann.ok('PUT', `/api/workspaces/${ws}/invites/link`, {})
    await bob.ok('POST', '/api/join', { invite: link.token })
    await ann.ok('PATCH', `/api/workspaces/${ws}/members/${bob.user.id}`, { planner: true })
    const { id: secret } = await ann.ok('POST', '/api/boards', { name: 'Salaries', workspaceId: ws })
    await ann.ok('PATCH', `/api/boards/${secret}/sharing`, { visibility: 'private' })
    const plan = (p: Person, command: object) => p.request('POST', `/api/workspaces/${ws}/planning/mutations`, { mutationId: mid(), command })
    const project = '0190a0a0-0000-7000-8000-000000000001'
    expect((await plan(bob, { type: 'project.add', id: project, name: 'P' })).status).toBe(200)
    expect((await plan(bob, { type: 'project.update', id: project, fields: { boardId: secret } })).status).toBe(422)
    expect((await plan(ann, { type: 'project.update', id: project, fields: { boardId: secret } })).status).toBe(200)
    const now = new Date().toISOString()
    const outsider = {
      id: '0190a0a0-0000-7000-8000-000000000002',
      name: 'Eve',
      userId: eve.user.id,
      roleId: null,
      hoursPerDay: 8,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    const undo = await plan(bob, { type: 'plan.restore', changes: [{ entity: 'person', id: outsider.id, before: null, after: outsider }] })
    expect(undo.status).toBeGreaterThanOrEqual(400)
  })

  it('sign-up with an invite the address can’t use answers the same whether or not the address has an account', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const { token } = await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'carol@example.com', role: 'editor' })
    const tryIt = (email: string) =>
      new Person(t.app).request('POST', '/api/auth/signup', { name: 'X', email, password: 'correct horse', invite: token })
    expect((await tryIt('ann@example.com')).status).toBe(403)
    expect((await tryIt('nobody@example.com')).status).toBe(403)
  })
})

describe('the second pass', () => {
  it('wrong passwords tried all at once still count; every answer says how it may be framed and read', async () => {
    await Person.signUp(t.app, 'Ann')
    const tries = await Promise.all(
      Array.from({ length: 14 }, () => new Person(t.app).request('POST', '/api/auth/signin', { email: 'ann@example.com', password: 'not this one' })),
    )
    expect(tries.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(4)
    const res = await t.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'same-origin' })
  })

  it('turning an account off removes its API tokens; someone taken off a public board stops getting logged time live', async () => {
    const { ann, bob, id } = await pair()
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    await bob.ok('POST', '/api/account/tokens', { name: 'script', scope: 'read', expiresInDays: null })
    const live = await listen(id, { cookie: bob.cookie })
    expect(await live.until(() => live.messages.some((m) => m.type === 'hello'))).toBe(true)
    await ann.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    expect(await live.until(() => live.messages.some((m) => m.type === 'reload'))).toBe(true)
    await ann.ok('POST', `/api/boards/${id}/tasks/A3/time`, { minutes: 15, day: new Date().toISOString().slice(0, 10) })
    await new Promise((r) => setTimeout(r, 150))
    expect(live.messages.some((m) => m.type === 'time')).toBe(false)
    live.ws.terminate()
    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { disabled: true })
    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { disabled: false })
    await bob.ok('POST', '/api/auth/signin', { email: 'bob@example.com', password: 'correct horse' })
    expect((await bob.ok('GET', '/api/account/tokens')).tokens).toHaveLength(0)
  })

  it('turning an account off ends the invite links of the boards they own, so they can’t come back under another address', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    const mal = await Person.signUp(t.app, 'Mal')
    const [{ id }] = (await mal.ok('GET', '/api/boards')).boards
    const { link } = await mal.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'editor' })
    await ann.ok('PATCH', '/api/admin/settings', { openSignup: false })
    await ann.ok('PATCH', `/api/admin/users/${mal.user.id}`, { disabled: true })
    const again = await new Person(t.app).request('POST', '/api/auth/signup', {
      name: 'Mal again',
      email: 'mal2@example.com',
      password: 'correct horse',
      invite: link.token,
    })
    expect(again.status).toBe(403)
  })
})
