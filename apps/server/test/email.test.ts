import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { decrypt } from '../src/crypto'
import { emailSenders, users } from '../src/db/schema'
import { SendError } from '../src/mail/transport'
import { buildApp } from '../src/app'
import { serverSender } from '../src/mail/senders'
import { MemoryTransport } from '../src/mail/transport'
import { flushMail, linkToken, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const KEY = 're_platform_1234567890abcd'

/** Ann: platform admin, with the platform's email set up (her account is confirmed via reset below). */
async function platformWithEmail() {
  const ann = await Person.signUp(t.app, 'Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  await ann.ok('PUT', '/api/admin/email/sender', { apiKey: KEY, from: 'Kanbanto <noreply@kanbanto.example>' })
  return ann
}

describe('platform email settings', () => {
  it('tests the key by emailing the admin, stores it encrypted, and never shows it again', async () => {
    const ann = await platformWithEmail()
    // The test email went to Ann, with the key she pasted.
    expect(t.mail.last('ann@example.com')).toMatchObject({
      apiKey: KEY,
      subject: 'Your Kanbanto email settings are working',
      from: 'Kanbanto <noreply@kanbanto.example>',
    })
    const view = await ann.ok('GET', '/api/admin/email')
    expect(view.sender).toMatchObject({ keyHint: 're_…abcd', working: true, testingOnly: false })
    expect(JSON.stringify(view)).not.toContain(KEY)
    // In the database: encrypted, not the key itself.
    const [row] = await t.db.select().from(emailSenders)
    expect(row.apiKeyEncrypted).not.toContain(KEY)
    expect(decrypt(row.apiKeyEncrypted)).toBe(KEY)
    // Changing only the sender keeps the saved key.
    await ann.ok('PUT', '/api/admin/email/sender', { from: 'Kanbanto <hello@kanbanto.example>' })
    expect(t.mail.last('ann@example.com')?.apiKey).toBe(KEY)
  })

  it('saves nothing when the provider refuses the test, and says why', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    t.mail.fail = new SendError(403, 'The kanbanto.example domain is not verified.')
    const r = await ann.request('PUT', '/api/admin/email/sender', { apiKey: KEY, from: 'Kanbanto <noreply@kanbanto.example>' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/not verified.*resend\.com\/domains/)
    expect((await ann.ok('GET', '/api/admin/email')).sender).toBeNull()
  })

  it('text the database can’t hold is refused as a bad request, not a server error', async () => {
    const ann = await platformWithEmail()
    expect(await ann.request('PATCH', '/api/admin/email/settings', { footer: 'Our address\u0000' })).toMatchObject({
      status: 400,
      body: { error: 'That contains something that can’t be saved.' },
    })
  })

  it('only platform admins can change it; previews render with the branding', async () => {
    const ann = await platformWithEmail()
    const bob = await (await Person.signUp(t.app, 'Bob')).confirm(t.mail, 'bob@example.com')
    expect((await bob.request('GET', '/api/admin/email')).status).toBe(403)
    await ann.ok('PATCH', '/api/admin/email/settings', { brandName: 'Acme Tasks', brandColor: '#ff5500' })
    const preview = await ann.request<string>('GET', '/api/admin/email/preview/invite')
    expect(preview.status).toBe(200)
    expect(preview.body).toContain('Acme Tasks')
    expect(preview.body).toContain('#ff5500')
  })
})

describe('an SMTP server for the platform', () => {
  const SMTP = {
    provider: 'smtp',
    host: 'smtp.corp.example',
    port: 587,
    security: 'starttls',
    username: 'kanbanto@corp.example',
    password: 'hunter2-long-password',
    from: 'Kanbanto <kanbanto@corp.example>',
  }

  it('tests it, keeps the password encrypted, and takes the Resend limits off', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PUT', '/api/admin/email/sender', SMTP)
    expect(t.mail.last('ann@example.com')?.credentials).toEqual({
      provider: 'smtp',
      host: 'smtp.corp.example',
      port: 587,
      security: 'starttls',
      username: 'kanbanto@corp.example',
      password: 'hunter2-long-password',
      allowSelfSigned: false,
    })
    const view = await ann.ok('GET', '/api/admin/email')
    expect(view.sender).toMatchObject({
      provider: 'smtp',
      keyHint: 'smtp.corp.example:587',
      fromServer: false,
      smtp: { username: 'kanbanto@corp.example' },
    })
    expect(JSON.stringify(view)).not.toContain('hunter2')
    const [row] = await t.db.select().from(emailSenders)
    expect(decrypt(row.apiKeyEncrypted)).toBe('hunter2-long-password')
    // The limits were Resend's free plan: gone with the site's own server.
    expect(view.settings).toMatchObject({ dailyBudget: null, monthlyBudget: null, userAllowance: null })

    // Changing the port keeps the saved password; clearing the username drops it (a relay without sign-in).
    const { password: _, ...noPassword } = SMTP
    await ann.ok('PUT', '/api/admin/email/sender', { ...noPassword, port: 2525 })
    expect(t.mail.last('ann@example.com')?.credentials).toMatchObject({ port: 2525, password: 'hunter2-long-password' })
    await ann.ok('PUT', '/api/admin/email/sender', { ...noPassword, host: 'relay.corp.example', port: 25, security: 'none', username: '' })
    expect(t.mail.last('ann@example.com')?.credentials).toMatchObject({ username: null, password: null, security: 'none' })
    // …and sends with the saved (empty) password afterwards.
    await ann.ok('POST', '/api/admin/email/test/invite')
    expect(t.mail.last('ann@example.com')?.credentials).toMatchObject({ host: 'relay.corp.example', password: null })
  })

  it('keeps limits someone chose, and sends without limits when there are none', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    await ann.ok('PATCH', '/api/admin/email/settings', { dailyBudget: 500 })
    await ann.ok('PUT', '/api/admin/email/sender', SMTP)
    expect((await ann.ok('GET', '/api/admin/email')).settings).toMatchObject({ dailyBudget: 500, monthlyBudget: 2800 })
    await ann.ok('PATCH', '/api/admin/email/settings', { dailyBudget: null, monthlyBudget: null, userAllowance: null })
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    for (const n of [1, 2, 3])
      expect(await ann.ok('POST', `/api/boards/${id}/invitations`, { email: `z${n}@example.com`, role: 'viewer' })).toMatchObject({ emailed: true })
  })

  it('people’s own keys are Resend only', async () => {
    const bob = await Person.signUp(t.app, 'Bob')
    expect((await bob.request('PUT', '/api/account/email/sender', SMTP)).status).toBe(400)
    expect(t.mail.sent).toHaveLength(0)
  })

  it('a refused test says why, and saves nothing', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await setPlatformAdmin(t.db, 'ann@example.com', true)
    t.mail.fail = new SendError(401, 'The mail server refused the username or password (535 5.7.8 Authentication failed).')
    const r = await ann.request('PUT', '/api/admin/email/sender', SMTP)
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^The test email couldn’t be sent\. The mail server refused/) } })
    expect((await ann.ok('GET', '/api/admin/email')).sender).toBeNull()
  })
})

describe('email set on the server (SMTP_URL)', () => {
  it('sends with it, and the console shows it but can’t change it', async () => {
    const mail = new MemoryTransport()
    const app = await buildApp(t.db, {
      transport: mail,
      serverSender: serverSender({ smtpUrl: 'smtps://kb:pw@smtp.corp.example', smtpFrom: 'Kanbanto <kb@corp.example>' }),
    })
    try {
      const ann = await (await Person.signUp(app, 'Ann')).confirm(mail, 'ann@example.com')
      await setPlatformAdmin(t.db, 'ann@example.com', true)
      expect((await ann.ok('GET', '/api/auth/me')).emailEnabled).toBe(true)
      const view = await ann.ok('GET', '/api/admin/email')
      expect(view.sender).toMatchObject({ provider: 'smtp', fromServer: true, keyHint: 'smtp.corp.example:465', from: 'Kanbanto <kb@corp.example>' })
      expect((await ann.request('PUT', '/api/admin/email/sender', { apiKey: KEY, from: 'x <x@example.com>' })).status).toBe(409)
      expect((await ann.request('DELETE', '/api/admin/email/sender')).status).toBe(409)
      await ann.ok('POST', '/api/admin/email/test/invite')
      expect(mail.last('ann@example.com')).toMatchObject({
        from: 'Kanbanto <kb@corp.example>',
        credentials: { host: 'smtp.corp.example', password: 'pw' },
      })
      // A failure shows on the console until a send works again.
      mail.fail = new SendError(401, 'The mail server refused the username or password.')
      const bob = await Person.signUp(app, 'Bob')
      await app.mail.process()
      expect((await ann.ok('GET', '/api/admin/email')).sender).toMatchObject({ working: false, lastError: expect.stringMatching(/refused/) })
      expect(bob.checkEmail).toBe(true)
    } finally {
      await app.close()
    }
  })
})

describe('confirming your email', () => {
  it('without platform email, nobody has to confirm', async () => {
    const bob = await Person.signUp(t.app, 'Bob')
    expect(bob.user.emailVerified).toBe(false)
    expect((await bob.request('GET', '/api/boards')).status).toBe(200)
  })

  it('accounts made before email was set up are asked once it is, unless an admin vouches for them', async () => {
    const bob = await Person.signUp(t.app, 'Bob')
    const ann = await platformWithEmail()
    expect((await ann.ok('GET', '/api/admin/email')).unconfirmed).toBe(1)
    expect(await bob.request('GET', '/api/boards')).toMatchObject({ status: 403, body: { code: 'verify-email' } })
    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { emailVerified: true })
    expect((await bob.request('GET', '/api/boards')).status).toBe(200)
    expect((await ann.ok('GET', '/api/admin/email')).unconfirmed).toBe(0)
  })

  it('once email is set up, a new account confirms its address first: the link signs it in', async () => {
    await platformWithEmail()
    const bob = await Person.signUp(t.app, 'Bob')
    expect(bob.checkEmail).toBe(true)
    expect((await bob.ok('GET', '/api/auth/me')).user).toBeNull() // not signed in until confirmed
    await flushMail(t.app)
    const email = t.mail.last('bob@example.com')
    expect(email?.subject).toBe('Confirm your email address for Kanbanto')
    expect(email?.text).toContain('Confirm email address')
    // Says why it arrived, and is signed.
    expect(email?.text).toContain('You’re receiving this because an account was created')
    expect(email?.text).toContain('The Kanbanto team')
    // Asking again straight away sends nothing more (and answers the same way).
    await new Person(t.app).ok('POST', '/api/auth/verify/resend', { email: 'bob@example.com' })
    await flushMail(t.app)
    expect(t.mail.sent.filter((e) => e.to === 'bob@example.com')).toHaveLength(1)
    // The link confirms the address and signs in, once: with the account's password, since this browser isn't signed
    // in to it (whoever clicks the link reads the inbox, but may not be who made the account).
    const token = linkToken(email?.text, 'verify')!
    expect(await bob.ok('POST', '/api/auth/verify', { token })).toMatchObject({ needsPassword: true, user: null })
    expect((await bob.request('POST', '/api/auth/verify', { token, password: 'not it at all' })).status).toBe(400)
    expect((await bob.request('GET', '/api/boards')).status).toBe(401)
    const r = await bob.ok('POST', '/api/auth/verify', { token, password: 'correct horse' })
    expect(r.user).toMatchObject({ email: 'bob@example.com', emailVerified: true })
    expect((await new Person(t.app).request('POST', '/api/auth/verify', { token })).status).toBe(400)
    expect((await bob.request('GET', '/api/boards')).status).toBe(200)
  })

  it('signing up with an address that has an account answers the same way, and tells its owner', async () => {
    await platformWithEmail()
    const signUp = (name: string, password: string) =>
      new Person(t.app).request('POST', '/api/auth/signup', { name, email: 'bob@example.com', password })
    const first = await signUp('Bob', 'correct horse')
    const again = await signUp('Mallory', 'another password')
    expect(again).toMatchObject({ status: 200, body: first.body })
    expect(again.headers['set-cookie']).toBeUndefined()
    await flushMail(t.app)
    expect(t.mail.last('bob@example.com')?.subject).toBe('You already have a Kanbanto account')
    // At most one such note an hour.
    await signUp('Mallory', 'another password')
    await flushMail(t.app)
    expect(t.mail.sent.filter((e) => e.subject === 'You already have a Kanbanto account')).toHaveLength(1)
  })

  it('an account that must confirm can sign in, but the app waits for the confirmation', async () => {
    await platformWithEmail()
    const bob = await Person.signUp(t.app, 'Bob')
    expect(bob.checkEmail).toBe(true)
    // Bob signs in with his password before confirming: the app is closed to him, live updates included.
    await bob.ok('POST', '/api/auth/signin', { email: 'bob@example.com', password: 'correct horse' })
    expect(await bob.request('GET', '/api/boards')).toMatchObject({ status: 403, body: { code: 'verify-email' } })
  })
})

describe('forgot password', () => {
  it('emails a one-time link that sets a new password and signs out everywhere else', async () => {
    await platformWithEmail()
    const bob = await Person.signUp(t.app, 'Bob')
    const anon = new Person(t.app)
    await anon.ok('POST', '/api/auth/forgot', { email: 'BOB@example.com' })
    // Unknown addresses get the same answer (no way to find out who has an account).
    await anon.ok('POST', '/api/auth/forgot', { email: 'nobody@example.com' })
    await flushMail(t.app)
    expect(t.mail.sent.filter((e) => e.to === 'nobody@example.com')).toHaveLength(0)
    const token = linkToken(t.mail.last('bob@example.com')?.text, 'reset')!
    expect(token).toBeTruthy()
    const r = await anon.ok('POST', '/api/auth/reset', { token, password: 'a brand new one' })
    expect(r.user).toMatchObject({ email: 'bob@example.com', emailVerified: true })
    expect((await bob.ok('GET', '/api/auth/me')).user).toBeNull() // the old session ended
    expect((await anon.request('POST', '/api/auth/reset', { token, password: 'another one!' })).status).toBe(400)
    await new Person(t.app).ok('POST', '/api/auth/signin', { email: 'bob@example.com', password: 'a brand new one' })
  })
})

describe('invites by email', () => {
  /** Ann is a platform admin, so she doesn't have to confirm her email (see the admin exemption). */
  async function annWithBoard() {
    const ann = await platformWithEmail()
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    return { ann, id }
  }

  it('someone without an account gets an invite that only works for their address, once', async () => {
    const { ann, id } = await annWithBoard()
    expect(await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'cara@example.com', role: 'editor' })).toMatchObject({
      outcome: 'invited',
      emailed: true,
    })
    await flushMail(t.app)
    const email = t.mail.last('cara@example.com')!
    expect(email.subject).toBe('Ann invited you to “My first board” on Kanbanto')
    expect(email.text).not.toMatch(/\bfree\b/i)
    const token = linkToken(email.text, 'join')!
    expect((await ann.ok('GET', `/api/boards/${id}/sharing`)).pending).toMatchObject([{ email: 'cara@example.com', role: 'editor' }])
    // Someone else can't use it.
    const dan = await (await Person.signUp(t.app, 'Dan')).confirm(t.mail, 'dan@example.com')
    expect((await dan.request('POST', '/api/join', { invite: token })).body.error).toMatch(/sent to cara@example.com/)
    // Cara signs up through it: joined, and her address counts as confirmed.
    const cara = await Person.signUp(t.app, 'Cara', { invite: token })
    expect(cara.joinedBoardId).toBe(id)
    expect(cara.user.emailVerified).toBe(true)
    expect((await ann.ok('GET', `/api/boards/${id}/sharing`)).pending).toEqual([])
  })

  it('an invite link the inviter was shown doesn’t prove the address of whoever uses it', async () => {
    const { ann, id } = await annWithBoard()
    await ann.ok('PATCH', '/api/admin/email/settings', { userAllowance: 0 })
    // No email goes out, so Ann gets the link: she could use it herself to make an account as the victim.
    const shown = await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'victim@example.com', role: 'editor' })
    expect(shown).toMatchObject({ emailed: false, token: expect.any(String) })
    const fake = await Person.signUp(t.app, 'Victim', { email: 'victim@example.com', invite: shown.token })
    expect(fake.checkEmail).toBe(true) // not confirmed: the address has to be proved by email
    const [row] = await t.db.select().from(users).where(eq(users.email, 'victim@example.com'))
    expect(row.emailVerifiedAt).toBeNull()

    // Someone else invites that address: the unconfirmed account isn't added; the invite goes to the address.
    await ann.ok('PATCH', '/api/admin/email/settings', { userAllowance: 20 })
    const bob = await (await Person.signUp(t.app, 'Bob')).confirm(t.mail, 'bob@example.com')
    const bobs = (await bob.ok('POST', '/api/boards', { name: 'Bob’s board' })).id
    const r = await bob.ok('POST', `/api/boards/${bobs}/invitations`, { email: 'victim@example.com', role: 'viewer' })
    expect(r).toMatchObject({ outcome: 'invited', emailed: true })
    expect((await bob.ok('GET', `/api/boards/${bobs}/sharing`)).members.map((m: { name: string }) => m.name)).toEqual(['Bob'])
    await flushMail(t.app)
    const invite = t.mail.last('victim@example.com')!
    expect(invite.text).toContain('sign in as victim@example.com and accept')

    // The real owner of the address takes the account back (reset link by email), then accepts: confirmed and joined.
    await new Person(t.app).ok('POST', '/api/auth/forgot', { email: 'victim@example.com' })
    await flushMail(t.app)
    const owner = new Person(t.app)
    await owner.ok('POST', '/api/auth/reset', { token: linkToken(t.mail.last('victim@example.com')?.text, 'reset'), password: 'mine again' })
    const joined = await owner.ok('POST', '/api/join', { invite: linkToken(invite.text, 'join') })
    expect(joined).toMatchObject({ boardId: bobs, role: 'viewer' })
  })

  it('accepting an invite emailed to you confirms your address', async () => {
    const { ann, id } = await annWithBoard()
    // Eve made an account earlier and never confirmed it.
    const eve = await Person.signUp(t.app, 'Eve')
    await eve.ok('POST', '/api/auth/signin', { email: 'eve@example.com', password: 'correct horse' })
    expect(await eve.request('GET', '/api/boards')).toMatchObject({ status: 403, body: { code: 'verify-email' } })
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'eve@example.com', role: 'viewer' })
    await flushMail(t.app)
    const token = linkToken(t.mail.last('eve@example.com')?.text, 'join')!
    expect(await eve.ok('POST', '/api/join', { invite: token })).toMatchObject({ boardId: id })
    expect((await eve.ok('GET', '/api/auth/me')).user.emailVerified).toBe(true)
  })

  it('invites use the inviter’s own key if they have one, else their monthly allowance', async () => {
    const { ann, id } = await annWithBoard()
    await ann.ok('PATCH', '/api/admin/email/settings', { userAllowance: 1 })
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'x1@example.com', role: 'viewer' })
    const second = await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'x2@example.com', role: 'viewer' })
    expect(second).toMatchObject({ emailed: false, why: expect.stringMatching(/this month’s invite emails/) })
    expect(second.token).toMatch(/^[\w-]{20,}$/)

    // With her own key, invites go out with it (and don't count against the site).
    await ann.ok('PUT', '/api/account/email/sender', { apiKey: 're_own_key_99998888', from: 'Ann <ann@annsdomain.example>' })
    expect(await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'x3@example.com', role: 'viewer' })).toMatchObject({ emailed: true })
    await flushMail(t.app)
    expect(t.mail.last('x3@example.com')).toMatchObject({ apiKey: 're_own_key_99998888', from: 'Ann <ann@annsdomain.example>' })
    const mine = await ann.ok('GET', '/api/account/email')
    expect(mine).toMatchObject({ sender: { keyHint: 're_…8888' }, allowance: { used: 1, limit: 1 } })
  })

  it('a key the provider rejects is flagged, so its owner sees why', async () => {
    const { ann, id } = await annWithBoard()
    await ann.ok('PUT', '/api/account/email/sender', { apiKey: 're_own_key_99998888', from: 'Ann <ann@annsdomain.example>' })
    t.mail.fail = new SendError(401, 'API key is invalid')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'x4@example.com', role: 'viewer' })
    await flushMail(t.app)
    const mine = await ann.ok('GET', '/api/account/email')
    expect(mine.sender).toMatchObject({ working: false, lastError: 'API key is invalid' })
    const [own] = await t.db.select().from(emailSenders).where(eq(emailSenders.fromAddress, 'Ann <ann@annsdomain.example>'))
    expect(own.failingSince).not.toBeNull()
  })

  it('the platform budget holds back invites first, keeping room for account emails', async () => {
    const { ann, id } = await annWithBoard()
    await ann.ok('PATCH', '/api/admin/email/settings', { dailyBudget: 5 })
    // Budget 5: invites may use 80% of it (4); the rest stays for sign-up and password emails.
    const results = []
    for (const n of [1, 2, 3, 4, 5])
      results.push(await ann.ok('POST', `/api/boards/${id}/invitations`, { email: `y${n}@example.com`, role: 'viewer' }))
    expect(results.map((r) => r.emailed)).toEqual([true, true, true, true, false])
    expect(results[4].why).toMatch(/limit/)
    // A password reset still goes out, using the room kept for account emails.
    await new Person(t.app).ok('POST', '/api/auth/forgot', { email: 'ann@example.com' })
    await flushMail(t.app)
    expect(t.mail.last('ann@example.com')?.subject).toBe('Reset your Kanbanto password')
    expect((await ann.ok('GET', '/api/admin/email')).usage.today).toBe(5)
  })
})
