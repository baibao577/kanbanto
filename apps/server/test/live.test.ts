import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LiveMessage } from '../src/live'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Opens a board's live connection and collects what it's sent. */
async function listen(p: Person, boardId: string) {
  const messages: LiveMessage[] = []
  const closed = { code: 0 }
  const ws: WebSocket = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers: p.cookie ? { cookie: p.cookie } : {} })
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  ws.on('close', (code) => (closed.code = code))
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20))
    return test()
  }
  return { ws, messages, closed, until }
}

describe('live', () => {
  it('everyone with the board open gets each change, tagged with its mutation id', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const bob = await Person.signUp(t.app, 'Bob')
    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'editor' })
    await bob.ok('POST', '/api/join', { invite: link.token })

    const bobLive = await listen(bob, id)
    expect(await bobLive.until(() => bobLive.messages.some((m) => m.type === 'hello'))).toBe(true)
    const hello = bobLive.messages.find((m) => m.type === 'hello') as { seq: number }

    const mutationId = mid()
    await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId, command: { type: 'task.update', id: 'A', fields: { title: 'Launch v2' } } })
    expect(await bobLive.until(() => bobLive.messages.some((m) => m.type === 'changes'))).toBe(true)
    const msg = bobLive.messages.find((m) => m.type === 'changes') as Extract<LiveMessage, { type: 'changes' }>
    expect(msg.seq).toBe(hello.seq + 1)
    expect(msg.mutationId).toBe(mutationId)
    expect(msg.changes[0]).toMatchObject({ entity: 'task', id: 'A', after: { title: 'Launch v2' } })
    bobLive.ws.terminate()
  })

  it('an id that marks a change as made from a board’s Telegram chat is the server’s to give', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const command = { type: 'task.update', id: 'A3', fields: { title: 'Deploy quietly' } }
    // (With it, the chat wouldn't be told of the change: nobody gets to say that of their own.)
    const marked = await ann.request('POST', `/api/boards/${id}/mutations`, { mutationId: 'tg:00000000-0000-4000-8000-000000000000:x', command })
    expect(marked.status).toBe(400)
    expect((await ann.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })).status).toBe(200)
  })

  it('people without access can’t listen, and are cut off when they lose it', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const bob = await Person.signUp(t.app, 'Bob')

    const stranger = await listen(bob, id)
    expect(await stranger.until(() => stranger.closed.code !== 0)).toBe(true)
    expect(stranger.closed.code).toBe(4403)

    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    const member = await listen(bob, id)
    await member.until(() => member.messages.length > 0)
    await ann.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    expect(await member.until(() => member.closed.code !== 0)).toBe(true)
    expect(member.messages.map((m) => m.type)).toContain('access-lost')
  })

  it('ending sessions closes their live connections', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    // Two devices: this one changes the password, the other one is signed out (and its live connection closed).
    const other = new Person(t.app)
    await other.ok('POST', '/api/auth/signin', { email: 'ann@example.com', password: 'correct horse' })
    const here = await listen(ann, id)
    const there = await listen(other, id)
    await here.until(() => here.messages.length > 0)
    await there.until(() => there.messages.length > 0)
    await ann.ok('POST', '/api/auth/password', { current: 'correct horse', next: 'a new password' })
    expect(await there.until(() => there.closed.code !== 0)).toBe(true)
    expect(there.closed.code).toBe(4401)
    expect(there.messages.map((m) => m.type)).toContain('signed-out')
    expect(here.closed.code).toBe(0)
    // Signing out closes this one too.
    await ann.ok('POST', '/api/auth/signout')
    expect(await here.until(() => here.closed.code !== 0)).toBe(true)
  })

  it('sharing changes tell open copies to reload; deleting tells them it’s gone', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const live = await listen(ann, id)
    await live.until(() => live.messages.length > 0)
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    expect(await live.until(() => live.messages.some((m) => m.type === 'reload'))).toBe(true)
    // A public board can be watched signed out.
    const anon = await listen(new Person(t.app), id)
    expect(await anon.until(() => anon.messages.some((m) => m.type === 'hello'))).toBe(true)
    await ann.ok('DELETE', `/api/boards/${id}`)
    expect(await anon.until(() => anon.messages.some((m) => m.type === 'deleted'))).toBe(true)
  })
})
