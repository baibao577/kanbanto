import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { version } from '../package.json'
import { Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

describe('accounts', () => {
  it('signing up never makes anyone a platform admin; only the server command does', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    expect(ann.user.isAdmin).toBe(false)
    expect((await ann.request('GET', '/api/admin/users')).status).toBe(403)
    expect(await setPlatformAdmin(t.db, ' ANN@example.com ', true)).toBe(true)
    expect((await ann.ok('GET', '/api/auth/me')).user.isAdmin).toBe(true)
    expect(await setPlatformAdmin(t.db, 'nobody@example.com', true)).toBe(false)
  })

  it('signs in with the right password only, with the same message for unknown emails', async () => {
    await Person.signUp(t.app, 'Ann')
    const p = new Person(t.app)
    const wrong = await p.request('POST', '/api/auth/signin', { email: 'ann@example.com', password: 'nope nope' })
    const unknown = await p.request('POST', '/api/auth/signin', { email: 'zed@example.com', password: 'nope nope' })
    expect(wrong.status).toBe(401)
    expect(unknown.body).toEqual(wrong.body)
    // Email isn't case-sensitive.
    await p.ok('POST', '/api/auth/signin', { email: ' ANN@example.com ', password: 'correct horse' })
    const me = await p.ok('GET', '/api/auth/me')
    expect(me.user.name).toBe('Ann')
    // Someone signed in is told which Kanbanto this is (no build day when run from the source); a visitor isn't.
    expect(me.version).toEqual({ number: version, built: null })
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    await p.ok('POST', '/api/auth/signout')
    expect(await p.ok('GET', '/api/auth/me')).toMatchObject({ user: null, version: null })
  })

  it('checks sign-up details', async () => {
    await Person.signUp(t.app, 'Ann')
    const p = new Person(t.app)
    expect((await p.request('POST', '/api/auth/signup', { name: 'A', email: 'ann@example.com', password: 'longenough' })).status).toBe(409)
    expect((await p.request('POST', '/api/auth/signup', { name: 'A', email: 'a@example.com', password: 'short' })).body.error).toMatch(/8 characters/)
    expect((await p.request('POST', '/api/auth/signup', { name: 'A', email: 'not-an-email', password: 'longenough' })).status).toBe(400)
  })

  it('closed sign-up still lets people in with an invite', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/settings', { openSignup: false })
    const p = new Person(t.app)
    const refused = await p.request('POST', '/api/auth/signup', { name: 'Bob', email: 'bob@example.com', password: 'correct horse' })
    expect(refused.status).toBe(403)
    const [board] = (await ann.ok('GET', '/api/boards')).boards
    const { link } = await ann.ok('PUT', `/api/boards/${board.id}/invites/link`, { role: 'editor' })
    await ann.ok('GET', `/api/boards/${board.id}`) // the server now has the board in memory
    const bob = await Person.signUp(t.app, 'Bob', { invite: link.token })
    expect(bob.joinedBoardId).toBe(board.id)
    // Ann's board knows about Bob at once, so she can assign him.
    const { data } = await ann.ok('GET', `/api/boards/${board.id}`)
    expect(data.members.map((m: { name: string }) => m.name)).toEqual(['Ann', 'Bob'])
    // Joined someone else's board, so no example board of their own.
    expect((await bob.ok('GET', '/api/boards')).boards.map((b: { id: string }) => b.id)).toEqual([board.id])
  })

  it('changing your password signs out your other devices', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const laptop = new Person(t.app)
    await laptop.ok('POST', '/api/auth/signin', { email: 'ann@example.com', password: 'correct horse' })
    expect((await ann.request('POST', '/api/auth/password', { current: 'wrong', next: 'new password' })).status).toBe(400)
    await ann.ok('POST', '/api/auth/password', { current: 'correct horse', next: 'new password' })
    expect((await ann.ok('GET', '/api/auth/me')).user).not.toBeNull()
    expect((await laptop.ok('GET', '/api/auth/me')).user).toBeNull()
  })

  it('platform admins turn accounts off and reset passwords, and see totals', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    expect((await bob.request('GET', '/api/admin/users')).status).toBe(403)
    expect((await ann.ok('GET', '/api/admin/users')).users).toHaveLength(2)
    expect(await ann.ok('GET', '/api/admin/stats')).toMatchObject({ users: 2, activeUsers: 2, boards: 2, newUsers: 2 })
    expect((await ann.request('PATCH', `/api/admin/users/${ann.user.id}`, { disabled: true })).status).toBe(400)
    // Admin rights can't be handed out through the website.
    expect((await ann.request('PATCH', `/api/admin/users/${bob.user.id}`, { isAdmin: true })).status).toBe(400)

    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { disabled: true })
    expect((await bob.ok('GET', '/api/auth/me')).user).toBeNull()
    const again = new Person(t.app)
    expect((await again.request('POST', '/api/auth/signin', { email: 'bob@example.com', password: 'correct horse' })).status).toBe(403)

    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { disabled: false })
    await again.ok('POST', '/api/auth/signin', { email: 'bob@example.com', password: 'correct horse' })
  })

  it('admins hand out a one-time reset link, and can vouch for an email address', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    expect((await bob.request('POST', `/api/admin/users/${ann.user.id}/reset-link`)).status).toBe(403)
    const { token } = await ann.ok('POST', `/api/admin/users/${bob.user.id}/reset-link`)
    expect(token).toMatch(/^[\w-]{20,}$/)
    // Nothing changes until it's used: Bob's password and sessions still work.
    expect((await bob.request('GET', '/api/boards')).status).toBe(200)
    const r = await new Person(t.app).ok('POST', '/api/auth/reset', { token, password: 'bob picked this' })
    // An admin's link doesn't prove Bob owns the address.
    expect(r.user).toMatchObject({ email: 'bob@example.com', emailVerified: false })
    expect((await bob.ok('GET', '/api/auth/me')).user).toBeNull()
    expect((await new Person(t.app).request('POST', '/api/auth/reset', { token, password: 'once more!' })).status).toBe(400)
    const bobAgain = new Person(t.app)
    await bobAgain.ok('POST', '/api/auth/signin', { email: 'bob@example.com', password: 'bob picked this' })

    // Vouching: only confirming, only by admins.
    expect((await bobAgain.request('PATCH', `/api/admin/users/${bob.user.id}`, { emailVerified: true })).status).toBe(403)
    expect((await ann.request('PATCH', `/api/admin/users/${bob.user.id}`, { emailVerified: false })).status).toBe(400)
    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { emailVerified: true })
    const listed = (await ann.ok('GET', '/api/admin/users')).users
    expect(listed.find((u: { id: string }) => u.id === bob.user.id)).toMatchObject({ emailVerified: true })
  })

  it('refuses changes sent from another site, whatever forwarding headers claim', async () => {
    const attempt = (headers: Record<string, string>) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/signin',
        headers: { host: 'kanbanto.example', ...headers },
        payload: { email: 'a@example.com', password: 'x' },
      })
    expect((await attempt({ origin: 'https://evil.example' })).statusCode).toBe(403)
    // No proxy is trusted by default, so a client can't vouch for itself with X-Forwarded-Host.
    expect((await attempt({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })).statusCode).toBe(403)
    expect((await attempt({ origin: 'https://kanbanto.example' })).statusCode).toBe(401)
  })

  it('too many wrong passwords for one address make it wait, whatever address they come from', async () => {
    await Person.signUp(t.app, 'Ann')
    const signIn = (password: string, ip: string) =>
      new Person(t.app).request('POST', '/api/auth/signin', { email: 'ann@example.com', password }, { 'x-forwarded-for': ip })
    for (let i = 0; i < 10; i++) expect((await signIn('wrong password', `203.0.113.${i}`)).status).toBe(401)
    // Even the right password has to wait now.
    expect(await signIn('correct horse', '198.51.100.7')).toMatchObject({ status: 429, body: { error: expect.stringMatching(/Wait 15 minutes/) } })
    // Unknown addresses are counted the same way, so the answer doesn't tell which ones have accounts.
    for (let i = 0; i < 10; i++) await new Person(t.app).request('POST', '/api/auth/signin', { email: 'nobody@example.com', password: 'x' })
    expect((await new Person(t.app).request('POST', '/api/auth/signin', { email: 'nobody@example.com', password: 'x' })).status).toBe(429)
  })

  it('names are one line of text', async () => {
    const r = await new Person(t.app).request('POST', '/api/auth/signup', {
      name: 'Ann\r\nBcc: x@example.com',
      email: 'ann@example.com',
      password: 'correct horse',
    })
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/control characters/) } })
  })
})
