import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { redactUrl } from '../src/app'
import { sessions, users } from '../src/db/schema'
import { Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const APP = { clientId: 'app-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }

/** Ann (a platform admin, with a password), the site's Google app saved, and signing in with Google turned on. */
async function site() {
  const ann = await Person.signUp(t.app, 'Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  await ann.ok('PUT', '/api/admin/calendar/google', APP)
  await ann.ok('PATCH', '/api/admin/settings', { googleSignIn: true })
  return ann
}

/** Who Google will say the next person is. */
const atGoogle = (who: Partial<typeof t.google.person>) => Object.assign(t.google.person, who)

/** Goes to Google and back in a browser of their own. Returns it (signed in if it worked) and where they land. */
async function viaGoogle(
  opts: { next?: string; invite?: string; answer?: { code?: string; state?: string; error?: string }; browser?: Person } = {},
) {
  const p = opts.browser ?? new Person(t.app)
  const { url } = await p.ok('POST', '/api/auth/google/start', { next: opts.next, invite: opts.invite })
  const answer = opts.answer ?? {}
  const q = new URLSearchParams(
    answer.error ? { error: answer.error } : { code: answer.code ?? 'good-code', state: answer.state ?? new URL(url).searchParams.get('state')! },
  )
  const r = await p.request('GET', `/api/auth/google/callback?${q}`)
  expect(r.status).toBe(302)
  const session = [r.headers['set-cookie']].flat().find((c) => c?.startsWith('kankan_session='))
  p.cookie = session ? session.split(';')[0] : ''
  const land = String(r.headers.location).replace(/^https?:\/\/[^/]+/, '')
  return { p, land, me: (await p.ok('GET', '/api/auth/me')).user as (Person['user'] & { hasPassword: boolean }) | null }
}

const row = async (email: string) => (await t.db.select().from(users).where(eq(users.email, email)))[0]
const signIn = (email: string, password: string) => new Person(t.app).request('POST', '/api/auth/signin', { email, password })

describe('turning it on', () => {
  it('is off until the site has a Google app and a platform admin turns it on', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    const visitor = new Person(t.app)
    expect((await visitor.ok('GET', '/api/auth/me')).googleSignIn).toBe(false)
    expect((await visitor.request('POST', '/api/auth/google/start')).status).toBe(403)
    // Not without the Google app it goes through.
    expect(await ann.request('PATCH', '/api/admin/settings', { googleSignIn: true })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/client ID and secret first/) },
    })
    const saved = await ann.ok('PUT', '/api/admin/calendar/google', APP)
    expect(saved.signInRedirectUri).toMatch(/\/api\/auth\/google\/callback$/)
    // The app alone (enough for calendars) doesn't turn sign-in on.
    expect((await visitor.ok('GET', '/api/auth/me')).googleSignIn).toBe(false)
    expect((await ann.ok('PATCH', '/api/admin/settings', { googleSignIn: true })).googleSignIn).toBe(true)
    expect((await visitor.ok('GET', '/api/auth/me')).googleSignIn).toBe(true)

    const { url } = await visitor.ok('POST', '/api/auth/google/start')
    const asked = new URL(url).searchParams
    expect(asked.get('client_id')).toBe(APP.clientId)
    expect(asked.get('redirect_uri')).toBe(saved.signInRedirectUri)
    expect(asked.get('scope')).toBe('openid email profile')

    // Taking the Google app away turns it off, and it stays off when an app is saved again.
    await ann.ok('DELETE', '/api/admin/calendar/google')
    expect((await visitor.ok('GET', '/api/auth/me')).googleSignIn).toBe(false)
    await ann.ok('PUT', '/api/admin/calendar/google', APP)
    expect((await ann.ok('GET', '/api/admin/settings')).googleSignIn).toBe(false)
  })

  it('turned off while someone is at Google: they come back to be told so', async () => {
    const ann = await site()
    const p = new Person(t.app)
    const { url } = await p.ok('POST', '/api/auth/google/start')
    const state = p.cookie
    await ann.ok('PATCH', '/api/admin/settings', { googleSignIn: false })
    p.cookie = state
    const r = await p.request('GET', `/api/auth/google/callback?code=good-code&state=${new URL(url).searchParams.get('state')}`)
    expect(r.headers.location).toMatch(/#\/signin\?problem=off$/)
  })

  it('keeps Google’s code out of the log', () => {
    expect(redactUrl('/api/auth/google/callback?code=4/secret&state=abc')).toBe('/api/auth/google/callback?[…]')
  })
})

describe('someone new', () => {
  it('gets an account at once: confirmed, named by Google, without a password, with the example board', async () => {
    await site()
    atGoogle({ sub: 'g-bob', email: 'Bob.Stone@Gmail.com', name: 'Bob Stone' })
    const { p, land, me } = await viaGoogle()
    expect(land).toBe('/')
    expect(me).toMatchObject({ email: 'bob.stone@gmail.com', name: 'Bob Stone', emailVerified: true, hasPassword: false, isAdmin: false })
    expect(await row('bob.stone@gmail.com')).toMatchObject({ googleSub: 'g-bob', passwordHash: null })
    expect((await p.ok('GET', '/api/boards')).boards.map((b: { name: string }) => b.name)).toEqual(['My first board'])
    // No confirmation email, and nothing else either.
    expect(t.mail.sent).toEqual([])
  })

  it('goes on to where they were going', async () => {
    await site()
    const next = '#/authorize?client_id=abc&state=x y'
    const { land, me } = await viaGoogle({ next })
    expect(me).not.toBeNull()
    expect(land).toBe(`/${next}`)
    // Only a place in the app: anything else is dropped.
    atGoogle({ sub: 'g-2', email: 'two@gmail.com' })
    expect((await viaGoogle({ next: 'https://elsewhere.example/' })).land).toBe('/')
  })

  it('without a name at Google, is named after their address', async () => {
    await site()
    atGoogle({ sub: 'g-cy', email: 'cy@gmail.com', name: null })
    expect((await viaGoogle()).me?.name).toBe('cy')
  })

  it('an address Google hasn’t checked makes no account', async () => {
    await site()
    atGoogle({ sub: 'g-dee', email: 'dee@example.org', emailVerified: false, hosted: false })
    const { land, me } = await viaGoogle()
    expect(land).toBe('/#/signin?problem=unverified')
    expect(me).toBeNull()
    expect(await row('dee@example.org')).toBeUndefined()
  })

  it('with sign-up closed, is refused without an invite and let in with one', async () => {
    const ann = await site()
    await ann.ok('PATCH', '/api/admin/settings', { openSignup: false })
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com', name: 'Bob' })
    const refused = await viaGoogle({ next: '#/b/somewhere' })
    expect(refused.land).toBe(`/#/signin?problem=closed&next=${encodeURIComponent('#/b/somewhere')}`)
    expect(refused.me).toBeNull()
    expect(await row('bob@gmail.com')).toBeUndefined()
    // An invite that doesn't exist is no better.
    expect((await viaGoogle({ invite: 'not-an-invite' })).land).toBe('/#/signin?problem=invite')

    const [board] = (await ann.ok('GET', '/api/boards')).boards
    const { link } = await ann.ok('PUT', `/api/boards/${board.id}/invites/link`, { role: 'editor' })
    await ann.ok('GET', `/api/boards/${board.id}`) // the server now has the board in memory
    const { p, land, me } = await viaGoogle({ invite: link.token, next: `#/join/${link.token}` })
    expect(me?.name).toBe('Bob')
    expect(land).toBe(`/#/b/${board.id}`)
    // On Ann's board at once, and no example board of their own.
    const { data } = await ann.ok('GET', `/api/boards/${board.id}`)
    expect(data.members.map((m: { name: string }) => m.name)).toEqual(['Ann', 'Bob'])
    expect((await p.ok('GET', '/api/boards')).boards.map((b: { id: string }) => b.id)).toEqual([board.id])
  })
})

describe('someone who already has an account', () => {
  it('with a confirmed address is the same account either way: Google or their password', async () => {
    const ann = await site()
    await ann.ok('PATCH', `/api/admin/users/${ann.user.id}`, { emailVerified: true })
    atGoogle({ sub: 'g-ann', email: 'ann@example.com', name: 'Ann at Google', hosted: true })
    const { p, me } = await viaGoogle()
    // Her account as it was: its name, its admin rights, its boards, its password.
    expect(me).toMatchObject({ id: ann.user.id, name: 'Ann', isAdmin: true, hasPassword: true })
    expect((await p.ok('GET', '/api/boards')).boards).toHaveLength(1)
    expect((await signIn('ann@example.com', 'correct horse')).status).toBe(200)
    // The browser she was signed in on stays signed in.
    expect((await ann.ok('GET', '/api/auth/me')).user).not.toBeNull()
    expect((await t.db.select().from(users)).length).toBe(1)
  })

  it('is found by their Google account from then on, whatever address Google has for it later', async () => {
    const ann = await site()
    await ann.ok('PATCH', `/api/admin/users/${ann.user.id}`, { emailVerified: true })
    atGoogle({ sub: 'g-ann', email: 'ann@example.com' })
    await viaGoogle()
    atGoogle({ sub: 'g-ann', email: 'ann.new@gmail.com', emailVerified: false })
    const { me } = await viaGoogle()
    expect(me).toMatchObject({ id: ann.user.id, email: 'ann@example.com' })
    // And another Google account with her address isn't her.
    atGoogle({ sub: 'g-other', email: 'ann@example.com', emailVerified: true })
    const other = await viaGoogle()
    expect(other.land).toBe('/#/signin?problem=password')
    expect(other.me).toBeNull()
  })

  it('that never confirmed its address: Google’s owner takes it over, and whoever made it is out', async () => {
    await site()
    // Someone signs up with Bob's address and a password of their own.
    const squatter = await Person.signUp(t.app, 'Bob', { email: 'bob@gmail.com' })
    expect((await squatter.ok('GET', '/api/auth/me')).user.emailVerified).toBe(false)
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com' })
    const { me } = await viaGoogle()
    expect(me).toMatchObject({ id: squatter.user.id, emailVerified: true, hasPassword: false })
    expect((await squatter.ok('GET', '/api/auth/me')).user).toBeNull()
    expect((await signIn('bob@gmail.com', 'correct horse')).status).toBe(401)
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, squatter.user.id))).toHaveLength(1)
  })

  it('with an address Google doesn’t run the mailbox of: their password it is', async () => {
    const ann = await site()
    await ann.ok('PATCH', `/api/admin/users/${ann.user.id}`, { emailVerified: true })
    atGoogle({ sub: 'g-ann', email: 'ann@example.com', hosted: false })
    const { land, me } = await viaGoogle()
    expect(land).toBe('/#/signin?problem=password')
    expect(me).toBeNull()
    expect((await row('ann@example.com')).googleSub).toBeNull()
  })

  it('that was turned off stays out', async () => {
    const ann = await site()
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com' })
    const bob = await viaGoogle()
    await ann.ok('PATCH', `/api/admin/users/${bob.me!.id}`, { disabled: true })
    const again = await viaGoogle()
    expect(again.land).toBe('/#/signin?problem=disabled')
    expect(again.me).toBeNull()
    // By address too (an account that never used Google).
    const cy = await Person.signUp(t.app, 'Cy', { email: 'cy@gmail.com' })
    await ann.ok('PATCH', `/api/admin/users/${cy.user.id}`, { disabled: true })
    atGoogle({ sub: 'g-cy', email: 'cy@gmail.com' })
    expect((await viaGoogle()).land).toBe('/#/signin?problem=disabled')
  })
})

describe('coming back from Google', () => {
  it('only counts in the browser that started it, with what Google was given', async () => {
    await site()
    expect((await viaGoogle({ answer: { state: 'made-up' } })).land).toBe('/#/signin?problem=expired')
    // No start at all (another browser, or the ten minutes ran out).
    const cold = await new Person(t.app).request('GET', '/api/auth/google/callback?code=good-code&state=anything')
    expect(cold.headers.location).toMatch(/#\/signin\?problem=expired$/)
    expect(await t.db.select().from(users)).toHaveLength(1)
  })

  it('saying no at Google goes back to the page with nothing to explain; a bad code says it didn’t work', async () => {
    await site()
    expect((await viaGoogle({ answer: { error: 'access_denied' }, next: '#/b/x' })).land).toBe(`/#/signin?next=${encodeURIComponent('#/b/x')}`)
    expect((await viaGoogle({ answer: { error: 'server_error' } })).land).toBe('/#/signin?problem=failed')
    expect((await viaGoogle({ answer: { code: 'stale' } })).land).toBe('/#/signin?problem=failed')
    t.google.badApp = 'The provided client secret is invalid.'
    expect((await viaGoogle()).land).toBe('/#/signin?problem=setup')
  })
})

describe('an account without a password', () => {
  it('can’t be signed in to with one, and says nothing about why', async () => {
    await site()
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com' })
    await viaGoogle()
    const wrong = await signIn('bob@gmail.com', 'anything at all')
    const unknown = await signIn('nobody@gmail.com', 'anything at all')
    expect(wrong.status).toBe(401)
    expect(wrong.body).toEqual(unknown.body)
    expect((await signIn('bob@gmail.com', '')).status).toBe(400)
  })

  it('adds one with no current password to give, and from then on changing it asks for it', async () => {
    await site()
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com' })
    const { p } = await viaGoogle()
    await p.ok('POST', '/api/auth/password', { next: 'a new password' })
    expect((await p.ok('GET', '/api/auth/me')).user.hasPassword).toBe(true)
    expect((await signIn('bob@gmail.com', 'a new password')).status).toBe(200)
    expect((await p.request('POST', '/api/auth/password', { next: 'another one' })).status).toBe(400)
    await p.ok('POST', '/api/auth/password', { current: 'a new password', next: 'another one' })
    // Google still works.
    expect((await viaGoogle()).me?.email).toBe('bob@gmail.com')
  })

  it('gets one from a platform admin’s reset link', async () => {
    const ann = await site()
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com' })
    const bob = await viaGoogle()
    const { token } = await ann.ok('POST', `/api/admin/users/${bob.me!.id}/reset-link`)
    await new Person(t.app).ok('POST', '/api/auth/reset', { token, password: 'picked by bob' })
    expect((await signIn('bob@gmail.com', 'picked by bob')).status).toBe(200)
  })
})

describe('sign-up only with Google', () => {
  const form = (name: string, email: string) => new Person(t.app).request('POST', '/api/auth/signup', { name, email, password: 'correct horse' })

  it('can’t be chosen before signing in with Google is on', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    expect(await ann.request('PATCH', '/api/admin/settings', { signupGoogleOnly: true })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/sign in with Google” first/) },
    })
    expect((await ann.ok('GET', '/api/admin/settings')).signupGoogleOnly).toBe(false)
  })

  it('refuses the form, makes accounts through Google, and leaves the form to people with an invite', async () => {
    const ann = await site()
    await ann.ok('PATCH', '/api/admin/settings', { openSignup: true, signupGoogleOnly: true })
    expect(await new Person(t.app).ok('GET', '/api/auth/me')).toMatchObject({ openSignup: true, signupGoogleOnly: true, googleSignIn: true })

    const refused = await form('Bob', 'bob@example.com')
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/made with Google/)
    expect(await row('bob@example.com')).toBeUndefined()
    // The same answer for an address that has an account.
    expect((await form('Ann', 'ann@example.com')).body).toEqual(refused.body)

    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com', name: 'Bob' })
    expect((await viaGoogle()).me).toMatchObject({ email: 'bob@gmail.com', hasPassword: false })

    // An invite still lets someone sign up with an email address and a password.
    const [board] = (await ann.ok('GET', '/api/boards')).boards
    const { link } = await ann.ok('PUT', `/api/boards/${board.id}/invites/link`, { role: 'editor' })
    await ann.ok('GET', `/api/boards/${board.id}`) // the server now has the board in memory
    const cy = await Person.signUp(t.app, 'Cy', { invite: link.token })
    expect(cy.joinedBoardId).toBe(board.id)
    // And people who have a password sign in with it as before.
    expect((await signIn('ann@example.com', 'correct horse')).status).toBe(200)
  })

  it('with signing in with Google turned off again, nobody signs up without an invite', async () => {
    const ann = await site()
    await ann.ok('PATCH', '/api/admin/settings', { openSignup: true, signupGoogleOnly: true })
    await ann.ok('PATCH', '/api/admin/settings', { googleSignIn: false })
    // The sign-up page is told it's closed, rather than the form quietly opening to everyone.
    expect(await new Person(t.app).ok('GET', '/api/auth/me')).toMatchObject({ openSignup: false, signupGoogleOnly: false, googleSignIn: false })
    expect((await form('Bob', 'bob@example.com')).status).toBe(403)
    // The choice is kept for when it's turned on again.
    expect(await ann.ok('GET', '/api/admin/settings')).toMatchObject({ openSignup: true, signupGoogleOnly: true, googleSignIn: false })
  })

  it('closed sign-up stays closed whatever this says', async () => {
    const ann = await site()
    await ann.ok('PATCH', '/api/admin/settings', { openSignup: false, signupGoogleOnly: true })
    expect(await new Person(t.app).ok('GET', '/api/auth/me')).toMatchObject({ openSignup: false, signupGoogleOnly: false })
    expect((await form('Bob', 'bob@example.com')).body.error).toMatch(/Sign-up is closed/)
    atGoogle({ sub: 'g-bob', email: 'bob@gmail.com' })
    expect((await viaGoogle()).land).toBe('/#/signin?problem=closed')
  })
})
