import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LiveMessage } from '../src/live'
import { PICTURE_MAX } from '../src/pictures'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])

const put = (p: Person, bytes: Buffer, type = 'image/png', more: Record<string, string> = {}) =>
  p.request('PUT', '/api/account/picture', bytes, { 'content-type': type, ...more })
const me = async (p: Person) => (await p.ok('GET', '/api/auth/me')).user as { name: string; picture: string | null }
const membersOf = async (p: Person, board: string) =>
  (await p.ok('GET', `/api/boards/${board}`)).data.members as { id: string; name: string; picture?: string }[]

/** Opens a board's live connection and collects what it's sent. */
async function listen(p: Person, boardId: string) {
  const messages: LiveMessage[] = []
  const ws: WebSocket = await t.app.injectWS(`/api/boards/${boardId}/live`, { headers: p.cookie ? { cookie: p.cookie } : {} })
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20))
    return test()
  }
  return { ws, messages, until }
}

/** Ann owns the example board and Bob can edit it. */
async function pair() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  return { ann, bob, id }
}

describe('profile pictures', () => {
  it('a person sets a picture: it comes with their account, and anyone with its link can load it', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    expect((await me(ann)).picture).toBeNull()

    const saved = await put(ann, PNG)
    expect(saved.status).toBe(200)
    const link = saved.body.user.picture as string
    expect(link).toMatch(/^\/api\/pictures\/[\w-]{16,}$/)
    expect((await me(ann)).picture).toBe(link)

    // Signed out too: a board's public link shows who its cards are assigned to.
    const got = await new Person(t.app).request('GET', link)
    expect(got.status).toBe(200)
    expect(got.raw.equals(PNG)).toBe(true)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(got.headers['x-content-type-options']).toBe('nosniff')
  })

  it('what it is goes by its bytes; what isn’t a picture, is too big, or comes from no one is refused', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    // Called a PNG, really a JPEG: kept as what it is.
    const jpeg = await put(ann, JPEG, 'image/png')
    expect((await ann.request('GET', jpeg.body.user.picture)).headers['content-type']).toBe('image/jpeg')

    // A web page called a picture, a GIF, an SVG: none of them.
    expect((await put(ann, Buffer.from('<html><script>alert(1)</script></html>'))).status).toBe(415)
    expect((await put(ann, Buffer.from('GIF89a........'))).status).toBe(415)
    expect((await put(ann, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status).toBe(415)
    expect((await put(ann, PNG, 'application/octet-stream')).status).toBe(415)
    expect((await ann.request('PUT', '/api/account/picture', { picture: 'x' })).status).toBe(400)

    // Too big: refused by the size it gives, and by its real size when that was a lie.
    const big = Buffer.concat([PNG, Buffer.alloc(PICTURE_MAX)])
    expect((await put(ann, big)).status).toBe(413)
    expect((await put(ann, big, 'image/png', { 'content-length': '100' })).status).toBeGreaterThanOrEqual(400)

    // Still the JPEG.
    expect((await me(ann)).picture).toBe(jpeg.body.user.picture)

    // Signed out, and with an API token (an account's own settings are changed on the website).
    expect((await put(new Person(t.app), PNG)).status).toBe(401)
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    const { token } = await ann.ok('POST', '/api/account/tokens', { name: 'script', scope: 'write', expiresInDays: null })
    expect((await put(new Person(t.app), PNG, 'image/png', { authorization: `Bearer ${token}` })).status).toBe(403)
    expect((await new Person(t.app).request('DELETE', '/api/account/picture', undefined, { authorization: `Bearer ${token}` })).status).toBe(403)
  })

  it('a new picture has a new link and the old one is gone; removing it gives the initials back', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const first = (await put(ann, PNG)).body.user.picture as string
    const second = (await put(ann, JPEG, 'image/jpeg')).body.user.picture as string
    expect(second).not.toBe(first)
    expect((await ann.request('GET', first)).status).toBe(404)
    expect((await ann.request('GET', second)).status).toBe(200)

    const removed = await ann.ok('DELETE', '/api/account/picture')
    expect(removed.user.picture).toBeNull()
    expect((await me(ann)).picture).toBeNull()
    expect((await ann.request('GET', second)).status).toBe(404)
    // Nothing to remove: fine.
    await ann.ok('DELETE', '/api/account/picture')
    expect((await ann.request('GET', '/api/pictures/nope')).status).toBe(400)
    expect((await ann.request('GET', '/api/pictures/aaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404)
  })

  it('boards they’re on show it at once, to people who have them open and to visitors of a public link', async () => {
    const { ann, bob, id } = await pair()
    // The board is in the server's memory, and Ann has it open.
    expect((await membersOf(ann, id)).find((m) => m.id === bob.user.id)?.picture).toBeUndefined()
    const live = await listen(ann, id)
    await live.until(() => live.messages.some((m) => m.type === 'hello'))
    const before = (await ann.ok('GET', '/api/boards')).boards.map((b: { id: string }) => b.id)

    const link = (await put(bob, PNG)).body.user.picture as string
    expect(await live.until(() => live.messages.some((m) => m.type === 'reload'))).toBe(true)
    expect((await membersOf(ann, id)).find((m) => m.id === bob.user.id)?.picture).toBe(link)
    // Nothing happened on the board: it keeps its place among the boards.
    expect((await ann.ok('GET', '/api/boards')).boards.map((b: { id: string }) => b.id)).toEqual(before)

    // A command still goes through on the board as it is now.
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A', fields: { title: 'Launch v2' } },
    })
    expect((await membersOf(ann, id)).find((m) => m.id === bob.user.id)?.picture).toBe(link)

    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const visitor = new Person(t.app)
    expect((await membersOf(visitor, id)).find((m) => m.id === bob.user.id)?.picture).toBe(link)
    expect((await visitor.request('GET', link)).status).toBe(200)

    live.messages.length = 0
    await bob.ok('DELETE', '/api/account/picture')
    expect(await live.until(() => live.messages.some((m) => m.type === 'reload'))).toBe(true)
    expect((await membersOf(ann, id)).find((m) => m.id === bob.user.id)?.picture).toBeUndefined()
    live.ws.terminate()
  })

  it('a new name reaches the boards they’re on too', async () => {
    const { ann, bob, id } = await pair()
    expect((await membersOf(ann, id)).map((m) => m.name).sort()).toEqual(['Ann', 'Bob'])
    const live = await listen(ann, id)
    await live.until(() => live.messages.some((m) => m.type === 'hello'))

    await bob.ok('PATCH', '/api/auth/me', { name: 'Robert' })
    expect(await live.until(() => live.messages.some((m) => m.type === 'reload'))).toBe(true)
    expect((await membersOf(ann, id)).map((m) => m.name).sort()).toEqual(['Ann', 'Robert'])

    // Something else about them (not the name): the boards are left alone.
    live.messages.length = 0
    await bob.ok('PATCH', '/api/auth/me', { mentionEmails: false, name: 'Robert' })
    await new Promise((r) => setTimeout(r, 100))
    expect(live.messages.some((m) => m.type === 'reload')).toBe(false)
    live.ws.terminate()
  })

  it('it comes with them wherever they’re listed: comments, logged time, sharing, a workspace, search, the console', async () => {
    const { ann, bob, id } = await pair()
    const link = (await put(bob, PNG)).body.user.picture as string

    await bob.ok('POST', `/api/boards/${id}/tasks/A/comments`, { body: 'On it.' })
    const { comments } = await ann.ok('GET', `/api/boards/${id}/tasks/A/comments`)
    expect(comments[0].author).toMatchObject({ name: 'Bob', picture: link })

    const sharing = await ann.ok('GET', `/api/boards/${id}/sharing`)
    const listed = (name: string) => sharing.members.find((m: { name: string }) => m.name === name)
    expect(listed('Bob')).toMatchObject({ picture: link, email: 'bob@example.com' })
    expect(listed('Ann').picture).toBeNull()
    // Someone who isn't an owner sees the pictures, and still only their own address.
    const asBob = (await bob.ok('GET', `/api/boards/${id}/sharing`)).members
    expect(asBob.find((m: { name: string }) => m.name === 'Ann')).not.toHaveProperty('email')
    expect(asBob.find((m: { name: string }) => m.name === 'Bob')).toMatchObject({ picture: link, email: 'bob@example.com' })

    const { id: ws } = await bob.ok('POST', '/api/workspaces', { name: 'Studio' })
    expect((await bob.ok('GET', `/api/workspaces/${ws}`)).members[0]).toMatchObject({ name: 'Bob', picture: link })

    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A', fields: { assigneeId: bob.user.id } },
    })
    const found = await ann.ok('GET', '/api/cards?state=all&assignee=' + bob.user.id)
    expect(found.cards[0]).toMatchObject({ assignee: 'Bob', assigneePicture: link })
    expect(found.people.find((p: { name: string }) => p.name === 'Bob').picture).toBe(link)

    await setPlatformAdmin(t.db, 'ann@example.com', true)
    const { users } = await ann.ok('GET', '/api/admin/users')
    expect(users.find((u: { name: string }) => u.name === 'Bob').picture).toBe(link)
    expect(users.find((u: { name: string }) => u.name === 'Ann').picture).toBeNull()
  })
})
