import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { redactUrl } from '../src/app'
import { GoogleError } from '../src/calendar/google'
import { calendarConnections, calendarEvents, siteSettings } from '../src/db/schema'
import { mid, Person, reset, setPlatformAdmin, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const run = (p: Person, board: string, command: object) => p.ok('POST', `/api/boards/${board}/mutations`, { mutationId: mid(), command })
const card = (p: Person, board: string, id: string, fields: object) => run(p, board, { type: 'task.create', id, parentId: null, fields })

/** Someone new, without the example board every new account gets (its cards have dates). */
async function signUp(name: string) {
  const p = await Person.signUp(t.app, name)
  for (const b of (await p.ok('GET', '/api/boards')).boards) await p.ok('DELETE', `/api/boards/${b.id}`)
  return p
}

/** Ann (a platform admin) and a board of her own, "Plans", with nothing on it. */
async function site(settings: { calendarLinks?: boolean; google?: boolean } = {}) {
  const ann = await signUp('Ann')
  await setPlatformAdmin(t.db, 'ann@example.com', true)
  if (settings.calendarLinks) await ann.ok('PATCH', '/api/admin/settings', { calendarLinks: true })
  if (settings.google)
    await ann.ok('PUT', '/api/admin/calendar/google', { clientId: 'app-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' })
  const { id } = await ann.ok('POST', '/api/boards', { name: 'Plans' })
  return { ann, id }
}

/** Bob, added to a board. */
async function join(owner: Person, board: string, name = 'Bob') {
  const p = await signUp(name)
  await owner.ok('POST', `/api/boards/${board}/invitations`, { email: `${name.toLowerCase()}@example.com`, role: 'editor' })
  return p
}

/** Goes to Google and back: returns where they land (…/#/account/calendar, with ?problem=… when it didn't work). */
async function connect(p: Person, answer: { code?: string; state?: string; error?: string } = {}) {
  const session = p.cookie
  const { url } = await p.ok('POST', '/api/account/calendar/google/start')
  p.cookie = `${session}; ${p.cookie}`
  const q = new URLSearchParams(
    answer.error ? { error: answer.error } : { code: answer.code ?? 'good-code', state: answer.state ?? new URL(url).searchParams.get('state')! },
  )
  const r = await p.request('GET', `/api/account/calendar/google/callback?${q}`)
  p.cookie = session
  expect(r.status).toBe(302)
  return String(r.headers.location)
}

const sync = (now?: Date) => t.app.calendar.process(now)
const feed = async (p: Person) => (await p.ok('GET', '/api/account/calendar')).link.url.replace(/^https?:\/\/[^/]+/, '') as string
const titles = (ics: string) => [...ics.matchAll(/^SUMMARY:(.*)$/gm)].map((m) => m[1].trim()).sort()

describe('the calendar link', () => {
  it('is off until a platform admin turns links on; then it lists your cards, and only yours', async () => {
    const { ann, id } = await site()
    expect(await ann.ok('GET', '/api/account/calendar')).toMatchObject({ linksEnabled: false, googleEnabled: false, link: null, google: null })
    expect((await ann.request('PUT', '/api/account/calendar/link')).status).toBe(403)
    await ann.ok('PATCH', '/api/admin/settings', { calendarLinks: true })

    await card(ann, id, 't1', { title: 'Pay rent', due: '2026-10-15' })
    await card(ann, id, 't2', {
      title: 'Call the bank',
      due: '2026-10-16T07:30:00Z',
      reminders: [{ id: 'r1', beforeDue: 60, by: ann.user.id }],
    })
    await card(ann, id, 't3', { title: 'No date' })
    const made = await ann.ok('PUT', '/api/account/calendar/link')
    expect(made.link.url).toMatch(/\/api\/calendar\/feed\/kbc_[\w-]+\/kanbanto\.ics$/)
    expect(made.boards).toEqual(expect.arrayContaining([{ id, name: 'Plans', off: false }]))

    const path = await feed(ann)
    const res = await new Person(t.app).request('GET', path)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8')
    const ics = res.body as unknown as string
    // Alone on her board, so nobody's cards are hers; in a link, a reminder is an event of its own.
    expect(titles(ics)).toEqual(['Call the bank', 'Pay rent', '⏰ Call the bank'])
    expect(ics).toContain('DTSTART;VALUE=DATE:20261015')
    expect(ics).toContain('DTSTART:20261016T073000Z')
    expect(ics).toContain('DTSTART:20261016T063000Z')
    expect(ics).toContain(`/#/b/${id}?task=t1`)

    // Unchanged: calendar apps are told so. Changed: they get it again.
    const again = await new Person(t.app).request('GET', path, undefined, { 'if-none-match': String(res.headers.etag) })
    expect(again.status).toBe(304)
    await run(ann, id, { type: 'task.update', id: 't1', fields: { title: 'Pay the rent' } })
    const changed = await new Person(t.app).request('GET', path, undefined, { 'if-none-match': String(res.headers.etag) })
    expect(titles(changed.body as unknown as string)).toContain('Pay the rent')

    // Someone else joins: cards assigned to nobody are no longer hers, and Bob's are his.
    const bob = await join(ann, id)
    await run(ann, id, { type: 'task.update', id: 't2', fields: { assigneeId: ann.user.id } })
    expect(titles((await ann.request('GET', path)).body as unknown as string)).toEqual(['Call the bank', '⏰ Call the bank'])
    await bob.ok('PUT', '/api/account/calendar/link')
    await run(ann, id, { type: 'task.update', id: 't1', fields: { assigneeId: bob.user.id } })
    expect(titles((await bob.request('GET', await feed(bob))).body as unknown as string)).toEqual(['Pay the rent'])
  })

  it('stops working when replaced, left out, turned off, or its account is', async () => {
    const { ann, id } = await site({ calendarLinks: true })
    await card(ann, id, 't1', { title: 'Pay rent', due: '2026-10-15' })
    await ann.ok('PUT', '/api/account/calendar/link')
    const first = await feed(ann)
    const anyone = new Person(t.app)
    expect((await anyone.request('GET', '/api/calendar/feed/kbc_nope/kanbanto.ics')).status).toBe(404)

    // A board left out of the calendar.
    expect((await ann.ok('PUT', `/api/account/calendar/boards/${id}`, { off: true })).boards).toContainEqual({ id, name: 'Plans', off: true })
    expect(titles((await anyone.request('GET', first)).body as unknown as string)).toEqual([])
    await ann.ok('PUT', `/api/account/calendar/boards/${id}`, { off: false })
    expect(titles((await anyone.request('GET', first)).body as unknown as string)).toEqual(['Pay rent'])
    // An archived board.
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    expect(titles((await anyone.request('GET', first)).body as unknown as string)).toEqual([])
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: false })

    // A new link: the old address is dead.
    await ann.ok('PUT', '/api/account/calendar/link')
    const second = await feed(ann)
    expect(second).not.toBe(first)
    expect((await anyone.request('GET', first)).status).toBe(404)
    expect((await anyone.request('GET', second)).status).toBe(200)

    // Links turned off for the site; then an account turned off.
    await ann.ok('PATCH', '/api/admin/settings', { calendarLinks: false })
    expect((await anyone.request('GET', second)).status).toBe(404)
    await ann.ok('PATCH', '/api/admin/settings', { calendarLinks: true })
    const bob = await join(ann, id)
    await bob.ok('PUT', '/api/account/calendar/link')
    const bobs = await feed(bob)
    expect((await anyone.request('GET', bobs)).status).toBe(200)
    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { disabled: true })
    expect((await anyone.request('GET', bobs)).status).toBe(404)

    await ann.ok('DELETE', '/api/account/calendar/link')
    expect((await anyone.request('GET', second)).status).toBe(404)
  })

  it('is kept out of the logs, and away from API tokens', async () => {
    expect(redactUrl('/api/calendar/feed/kbc_secret/kanbanto.ics')).toBe('/api/calendar/feed/[token]/kanbanto.ics')
    expect(redactUrl('/api/account/calendar/google/callback?code=4/abc&state=x')).toBe('/api/account/calendar/google/callback?[…]')
    const { ann } = await site()
    await ann.ok('PATCH', '/api/admin/settings', { apiTokens: true })
    const { token } = await ann.ok('POST', '/api/account/tokens', { name: 'script', scope: 'write', expiresInDays: null })
    const r = await new Person(t.app).request('GET', '/api/account/calendar', undefined, { authorization: `Bearer ${token}` })
    expect(r.status).toBe(403)
  })
})

describe('the site’s Google app', () => {
  it('is set by a platform admin; the secret is never sent back', async () => {
    const { ann } = await site()
    const bob = await signUp('Bob')
    expect((await bob.request('GET', '/api/admin/calendar/google')).status).toBe(403)
    expect((await bob.request('POST', '/api/account/calendar/google/start')).status).toBe(403)
    expect(await ann.ok('GET', '/api/admin/calendar/google')).toMatchObject({
      clientId: null,
      configured: false,
      redirectUri: expect.stringMatching(/\/api\/account\/calendar\/google\/callback$/),
    })
    expect((await ann.request('PUT', '/api/admin/calendar/google', { clientId: 'app-id' })).status).toBe(400)

    const saved = await ann.ok('PUT', '/api/admin/calendar/google', { clientId: ' app-id ', clientSecret: 'GOCSPX-secret' })
    expect(saved).toMatchObject({ clientId: 'app-id', configured: true, connections: 0 })
    expect(JSON.stringify(saved)).not.toContain('GOCSPX')
    const [row] = await t.db.select().from(siteSettings)
    expect(row.googleClientSecretEncrypted).toMatch(/^v1\./)
    // The ID alone can be changed, keeping the secret.
    expect(await ann.ok('PUT', '/api/admin/calendar/google', { clientId: 'other-id' })).toMatchObject({ clientId: 'other-id', configured: true })
    expect((await bob.ok('GET', '/api/account/calendar')).googleEnabled).toBe(true)

    expect(await ann.ok('DELETE', '/api/admin/calendar/google')).toMatchObject({ clientId: null, configured: false })
    expect((await bob.ok('GET', '/api/account/calendar')).googleEnabled).toBe(false)
  })
})

describe('connecting Google Calendar', () => {
  it('needs the answer Google was asked for, from the browser that asked', async () => {
    const { ann } = await site({ google: true })
    const session = ann.cookie
    const { url } = await ann.ok('POST', '/api/account/calendar/google/start')
    ann.cookie = session
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(new URL(url).searchParams.get('redirect_uri')).toMatch(/\/api\/account\/calendar\/google\/callback$/)

    expect(await connect(ann, { state: 'made-up' })).toMatch(/#\/account\/calendar\?problem=expired$/)
    expect(await connect(ann, { error: 'access_denied' })).toMatch(/\?problem=denied$/)
    expect(await connect(ann, { code: 'bad-code' })).toMatch(/\?problem=failed$/)
    // The calendar box left unticked on Google's page: nothing is kept.
    t.google.account.calendar = false
    expect(await connect(ann)).toMatch(/\?problem=permission$/)
    expect(t.google.revoked).toHaveLength(1)
    expect((await ann.ok('GET', '/api/account/calendar')).google).toBe(null)
    // Signed out when Google sends them back.
    const r = await new Person(t.app).request('GET', '/api/account/calendar/google/callback?code=good-code&state=x')
    expect(r.headers.location).toMatch(/\?problem=signin$/)

    t.google.account.calendar = true
    expect(await connect(ann)).toMatch(/#\/account\/calendar$/)
    expect((await ann.ok('GET', '/api/account/calendar')).google).toMatchObject({ email: 'someone@gmail.com', reconnect: false, problem: null })
    const [c] = await t.db.select().from(calendarConnections)
    expect(c.refreshTokenEncrypted).toMatch(/^v1\./)
  })

  it('fills a calendar of its own, and follows every change', async () => {
    const { ann, id } = await site({ google: true })
    await card(ann, id, 't1', { title: 'Pay rent', due: '2026-10-15' })
    await card(ann, id, 't2', {
      title: 'Call the bank',
      due: '2026-10-16T07:30:00Z',
      reminders: [
        { id: 'r1', beforeDue: 60, by: ann.user.id },
        { id: 'r2', at: '2026-10-17T02:00:00Z', by: ann.user.id },
      ],
    })
    await connect(ann)
    expect(await sync()).toBeGreaterThan(0)
    expect(t.google.calendars.size).toBe(1)
    expect(t.google.titles()).toEqual(['Call the bank', 'Pay rent', '⏰ Call the bank'])
    const events = () => [...[...t.google.calendars.values()][0].values()]
    const event = (title: string) => events().find((e) => e.summary === title)!
    expect(event('Pay rent')).toMatchObject({ start: { date: '2026-10-15' }, end: { date: '2026-10-16' }, transparency: 'transparent' })
    // A reminder before a due time is an alert on the event; one after it is an event of its own.
    expect(event('Call the bank')).toMatchObject({
      start: { dateTime: '2026-10-16T07:30:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-10-16T08:00:00Z', timeZone: 'UTC' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
    })
    expect(event('⏰ Call the bank').start).toEqual({ dateTime: '2026-10-17T02:00:00Z', timeZone: 'UTC' })
    expect(event('Pay rent').description).toContain(`/#/b/${id}?task=t1`)
    expect((await ann.ok('GET', '/api/account/calendar')).google.lastSyncedAt).not.toBe(null)

    // Nothing changed: nothing is asked of Google.
    expect(await sync()).toBe(0)

    // A new due date changes the event in place; a change that doesn't show in the calendar sends nothing.
    await run(ann, id, { type: 'task.update', id: 't1', fields: { due: '2026-10-20' } })
    expect(await sync()).toBe(1)
    expect(event('Pay rent').start).toEqual({ date: '2026-10-20' })
    await run(ann, id, { type: 'task.update', id: 't1', fields: { description: 'Landlord’s account' } })
    expect(await sync()).toBe(0)

    // Done: ticked, and its reminders go. No due date: gone. Archived: gone, and back when restored.
    await run(ann, id, { type: 'task.update', id: 't2', fields: { status: 'done' } })
    await sync()
    expect(t.google.titles()).toEqual(['Pay rent', '✓ Call the bank'])
    expect(event('✓ Call the bank').reminders.overrides).toEqual([])
    await run(ann, id, { type: 'task.update', id: 't2', fields: { due: '' } })
    await run(ann, id, { type: 'task.archive', id: 't1' })
    await sync()
    expect(t.google.titles()).toEqual([])
    await run(ann, id, { type: 'task.restore', id: 't1' })
    await sync()
    expect(t.google.titles()).toEqual(['Pay rent'])

    // A list that becomes a "done" list ticks its cards, though no card changed.
    await run(ann, id, { type: 'column.update', id: 'todo', fields: { category: 'done' } })
    await sync()
    expect(t.google.titles()).toEqual(['✓ Pay rent'])
    await run(ann, id, { type: 'task.delete', id: 't1' })
    await sync()
    expect(t.google.titles()).toEqual([])
  })

  it('follows who can open a board, and which boards are left out', async () => {
    const { ann, id } = await site({ google: true })
    const bob = await join(ann, id)
    await card(ann, id, 't1', { title: 'Bob’s card', due: '2026-10-15', assigneeId: bob.user.id })
    await card(ann, id, 't2', { title: 'Nobody’s card', due: '2026-10-15' })
    await connect(bob)
    await sync()
    expect(t.google.titles()).toEqual(['Bob’s card'])

    // Left out, and put back.
    await bob.ok('PUT', `/api/account/calendar/boards/${id}`, { off: true })
    await sync()
    expect(t.google.titles()).toEqual([])
    await bob.ok('PUT', `/api/account/calendar/boards/${id}`, { off: false })
    await sync()
    expect(t.google.titles()).toEqual(['Bob’s card'])

    // Archived by its owner, and restored.
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: true })
    await sync()
    expect(t.google.titles()).toEqual([])
    await ann.ok('POST', `/api/boards/${id}/archive`, { archived: false })
    await sync()
    expect(t.google.titles()).toEqual(['Bob’s card'])

    // Made private (only owners can open it), and shared again.
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { visibility: 'private' })
    await sync()
    expect(t.google.titles()).toEqual([])
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { visibility: 'invited' })
    await sync()
    expect(t.google.titles()).toEqual(['Bob’s card'])

    // A new board, made after connecting, on which he is alone: nobody's cards are his there.
    const { id: own } = await bob.ok('POST', '/api/boards', { name: 'Bob’s own' })
    await card(bob, own, 'x1', { title: 'Water the plants', due: '2026-10-18' })
    await sync()
    expect(t.google.titles()).toEqual(['Bob’s card', 'Water the plants'])
    await bob.ok('DELETE', `/api/boards/${own}`)
    await sync()
    expect(t.google.titles()).toEqual(['Bob’s card'])

    // Removed from the board: his card there is unassigned, and leaves his calendar.
    await ann.ok('DELETE', `/api/boards/${id}/members/${bob.user.id}`)
    await sync()
    expect(t.google.titles()).toEqual([])
    expect(await t.db.select().from(calendarEvents)).toEqual([])
  })

  it('waits and tries again when Google doesn’t answer, and asks to be connected again when Google refuses', async () => {
    const { ann, id } = await site({ google: true })
    await card(ann, id, 't1', { title: 'Pay rent', due: '2026-10-15' })
    await connect(ann)
    await sync()
    const now = new Date()

    t.google.fail = new GoogleError(503, 'Backend Error')
    await run(ann, id, { type: 'task.update', id: 't1', fields: { title: 'Pay the rent' } })
    await sync(now)
    expect((await ann.ok('GET', '/api/account/calendar')).google).toMatchObject({ problem: 'Backend Error', reconnect: false })
    t.google.fail = null
    // Not yet: it waits a minute first.
    expect(await sync(now)).toBe(0)
    expect(t.google.titles()).toEqual(['Pay rent'])
    const later = new Date(now.getTime() + 61_000)
    expect(await sync(later)).toBe(1)
    expect(t.google.titles()).toEqual(['Pay the rent'])
    expect((await ann.ok('GET', '/api/account/calendar')).google.problem).toBe(null)

    // They take the access away in their Google account.
    t.google.grants.clear()
    await run(ann, id, { type: 'task.update', id: 't1', fields: { title: 'Rent' } })
    await sync(later)
    expect((await ann.ok('GET', '/api/account/calendar')).google).toMatchObject({
      reconnect: true,
      problem: expect.stringMatching(/Connect it again/),
    })
    const calls = t.google.calls
    await run(ann, id, { type: 'task.update', id: 't1', fields: { title: 'The rent' } })
    await sync(new Date(now.getTime() + 24 * 3_600_000))
    expect(t.google.calls).toBe(calls)

    // Connected again (the same account): the same calendar carries on.
    await connect(ann)
    await sync()
    expect(t.google.calendars.size).toBe(1)
    expect(t.google.titles()).toEqual(['The rent'])
    expect((await ann.ok('GET', '/api/account/calendar')).google).toMatchObject({ reconnect: false, problem: null })
  })

  it('puts back what was deleted in Google, and a calendar that was', async () => {
    const { ann, id } = await site({ google: true })
    await card(ann, id, 't1', { title: 'Pay rent', due: '2026-10-15' })
    await card(ann, id, 't2', { title: 'Call the bank', due: '2026-10-16' })
    await connect(ann)
    await sync()
    const [calendarId, events] = [...t.google.calendars.entries()][0]

    // One event deleted there: it comes back when its card next changes.
    const [row] = (await t.db.select().from(calendarEvents)).filter((r) => r.taskId === 't1')
    events.delete(row.eventId)
    await run(ann, id, { type: 'task.update', id: 't1', fields: { title: 'Pay the rent' } })
    await sync()
    expect(t.google.titles()).toEqual(['Call the bank', 'Pay the rent'])

    // The whole calendar deleted there: a new one is made and filled.
    t.google.calendars.delete(calendarId)
    await run(ann, id, { type: 'task.update', id: 't2', fields: { due: '2026-10-17' } })
    await sync()
    await sync()
    expect([...t.google.calendars.keys()]).not.toContain(calendarId)
    expect(t.google.titles()).toEqual(['Call the bank', 'Pay the rent'])
  })

  it('disconnects: the calendar is removed from Google and the access given back', async () => {
    const { ann, id } = await site({ google: true })
    await card(ann, id, 't1', { title: 'Pay rent', due: '2026-10-15' })
    await connect(ann)
    await sync()
    expect(t.google.calendars.size).toBe(1)

    expect((await ann.ok('DELETE', '/api/account/calendar/google')).google).toBe(null)
    expect(t.google.calendars.size).toBe(0)
    expect(t.google.revoked).toHaveLength(1)
    expect(await t.db.select().from(calendarEvents)).toEqual([])
    await run(ann, id, { type: 'task.update', id: 't1', fields: { title: 'Rent' } })
    expect(await sync()).toBe(0)

    // An account that's turned off stops being synced.
    await connect(ann)
    await sync()
    const bob = await join(ann, id)
    await connect(bob)
    await card(ann, id, 't2', { title: 'Bob’s card', due: '2026-10-15', assigneeId: bob.user.id })
    await ann.ok('PATCH', `/api/admin/users/${bob.user.id}`, { disabled: true })
    await sync()
    expect(t.google.calendars.size).toBe(1)
    const [annsRow] = await t.db.select().from(calendarConnections).where(eq(calendarConnections.userId, ann.user.id))
    expect(t.google.titles(annsRow.calendarId!)).toEqual([])
  })
})
