import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok('GET', `/api/boards/${id}`)
const SALES = ['Deal value', 'Client', 'Contact email', 'Close date', 'Source']
/** What the board of clients shows: added with the first starter made in a space. */
const CLIENTS = ['Email', 'Phone']
const names = (fields: { name: string }[]) => fields.map((f) => f.name)
type Card = {
  id: string
  title: string
  status: string
  parentId: string | null
  custom?: Record<string, unknown>
  due?: string
  assigneeId?: string | null
  doneAt?: string
}
const cardsOf = (data: { tasks: Record<string, Card> }) => Object.values(data.tasks)
/** The boards someone made (a new account starts with the example board). */
const boardsOf = async (p: Person) =>
  (
    (await p.ok('GET', '/api/boards')).boards as {
      id: string
      name: string
      workspaceId: string | null
      inbox?: boolean
      archivedAt: string | null
    }[]
  ).filter((b) => b.name !== 'My first board' && !b.inbox && !b.archivedAt)
let m = 0
const mutate = (p: Person, id: string, command: object) =>
  p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: `00000000-0000-4000-8000-${String(++m).padStart(12, '0')}`, command })

describe('a board from a starter', () => {
  it('in Personal: its lists, fields, example cards and saved filters, with the fields added to your library once', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok('POST', '/api/boards', { name: 'Pipeline', template: 'sales', background: 'teal' })
    expect(made).toMatchObject({ added: [...SALES, ...CLIENTS], leftOut: [], clients: { made: true } })
    const { data } = await load(ann, made.id)
    expect(data.board).toMatchObject({
      name: 'Pipeline',
      mode: 'manual',
      background: 'teal',
      description: 'Deals from first contact to won or lost.',
    })
    expect(data.columns.map((c: { name: string; category: string }) => `${c.name}:${c.category}`)).toEqual([
      'Leads:todo',
      'Contacted:doing',
      'Proposal:doing',
      'Won:done',
      'Lost:done',
    ])
    expect(names(data.fields)).toEqual(SALES)
    expect(data.fields[0]).toMatchObject({ type: 'number', unit: '$', sum: true, front: true, total: true })
    expect(data.fields[3]).toMatchObject({ type: 'date', front: true })
    const library = (await ann.ok('GET', '/api/fields')).fields
    expect(names(library)).toEqual([...SALES, ...CLIENTS])
    expect(data.fields.map((f: { id: string }) => f.id)).toEqual(library.slice(0, 5).map((f: { id: string }) => f.id))
    // The example cards hold values for those fields, and the one that was won says when.
    const cards = cardsOf(data)
    expect(cards).toHaveLength(5)
    const [value, client, , close, source] = data.fields
    const first = cards.find((c) => c.title.startsWith('Northwind'))!
    expect(first.custom).toMatchObject({ [value.id]: 12000, [source.id]: ['st-source-website'] })
    expect(String(first.custom![close.id])).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(cards.find((c) => c.status === 'won')!.doneAt).toBeTruthy()
    expect(JSON.stringify(data)).not.toMatch(/st-sales-|st-client/)
    // Its saved filters name the library's fields, in the starter's order.
    const { presets } = await ann.ok('GET', `/api/boards/${made.id}/presets`)
    expect(presets.map((p: { name: string }) => p.name)).toEqual(['Closing in the next 7 days', 'Deals of 10,000 and up'])
    expect(presets[0].settings).toMatchObject({ filter: { fields: { [close.id]: { date: 'week' } } }, display: { board: { filter: 'main' } } })
    expect(presets[1].settings.filter.fields).toEqual({ [value.id]: { min: 10000 } })
    expect(presets[0].by).toBe('Ann')

    // Its clients: a board of their own that came with it, a card each, and every deal linked to the one it's for.
    expect(client).toMatchObject({ type: 'link', linkTo: 'board', board: made.clients.id, back: 'For this client', front: true })
    expect((await boardsOf(ann)).map((b) => b.name).sort()).toEqual(['Clients', 'Pipeline'])
    const clients = (await load(ann, made.clients.id)).data
    expect(clients.board).toMatchObject({ name: 'Clients', mode: 'manual' })
    expect(clients.columns.map((c: { name: string }) => c.name)).toEqual(['Clients', 'Past clients'])
    expect(names(clients.fields)).toEqual(CLIENTS)
    expect(clients.fields.map((f: { id: string }) => f.id)).toEqual(library.slice(5).map((f: { id: string }) => f.id))
    // (Every example client is there, this starter's first: the next starter finds its own.)
    const people = cardsOf(clients)
    expect(people).toHaveLength(9)
    expect(people.slice(0, 5).map((c) => c.title)).toEqual([
      'Northwind Traders',
      'Blue Harbor Cafe',
      'Pinecrest Dental',
      'Larkspur Studio',
      'Summit Cycles',
    ])
    const northwind = people.find((c) => c.title === 'Northwind Traders')!
    expect(Object.keys(northwind.custom ?? {}).sort()).toEqual(clients.fields.map((f: { id: string }) => f.id).sort())
    expect(first.custom![client.id]).toEqual([`${made.clients.id}:${northwind.id}`])
    for (const c of cards) {
      const [ref] = c.custom![client.id] as string[]
      expect(
        people.some((p) => ref === `${made.clients.id}:${p.id}`),
        c.title,
      ).toBe(true)
    }
    // Opened, the client's card lists what points at it.
    const from = await ann.ok('GET', `/api/boards/${made.clients.id}/tasks/${northwind.id}/linked-from`)
    expect(
      from.groups.map((g: { board: { name: string }; field: { back?: string }; cards: { title: string }[]; totals: object[] }) => [
        g.board.name,
        g.field.back,
        g.cards.map((c) => c.title),
        g.totals,
      ]),
    ).toEqual([['Pipeline', 'For this client', ['Northwind Traders: new website'], [{ name: 'Deal value', text: '$12,000' }]]])

    // A second one adds nothing, uses the same fields and the same clients. Someone else's has fields of their own.
    const again = await ann.ok('POST', '/api/boards', { name: 'Second', template: 'sales' })
    expect(again).toMatchObject({ added: [], clients: { id: made.clients.id, made: false } })
    const second = (await load(ann, again.id)).data
    expect(second.fields.map((f: { id: string }) => f.id)).toEqual(library.slice(0, 5).map((f: { id: string }) => f.id))
    expect(cardsOf(second).find((c) => c.title.startsWith('Northwind'))!.custom![client.id]).toEqual([`${made.clients.id}:${northwind.id}`])
    expect((await ann.ok('GET', '/api/fields')).fields).toHaveLength(7)
    expect((await boardsOf(ann)).filter((b) => b.name === 'Clients')).toHaveLength(1)
    expect(cardsOf((await load(ann, made.clients.id)).data)).toHaveLength(9)
    const bob = await Person.signUp(t.app, 'Bob')
    const his = await bob.ok('POST', '/api/boards', { name: 'His', template: 'sales' })
    expect((await load(bob, his.id)).data.fields[0].id).not.toBe(value.id)
    expect(his.clients).toMatchObject({ made: true })
    expect(his.clients.id).not.toBe(made.clients.id)
  })

  it('the support desk comes with labels, and a saved view sorted by a field', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok('POST', '/api/boards', { name: 'Help', template: 'support' })
    expect(made.added).toEqual(['Severity', 'Client', 'Customer email', 'Channel', 'Reported on', ...CLIENTS])
    const { data } = await load(ann, made.id)
    expect(data.labels.map((l: { name: string }) => l.name).sort()).toEqual(['Billing', 'Bug', 'Question'])
    expect(data.columns.map((c: { name: string }) => c.name)).toEqual(['New', 'In progress', 'Waiting on customer', 'Solved'])
    const severity = data.fields[0]
    expect(severity).toMatchObject({ name: 'Severity', type: 'choice', front: true })
    const { presets } = await ann.ok('GET', `/api/boards/${made.id}/presets`)
    expect(presets[0].settings.filter.fields).toEqual({ [severity.id]: { in: ['st-severity-high', 'st-severity-critical'] } })
    expect(presets[1].settings.outline.sort).toEqual({ key: `f:${severity.id}`, dir: 'desc' })
  })

  it('store orders: the items are subtasks, the day one has to leave is its due date, and the saved filters find cards from day one', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    // (Her day, not the server's: the far side of the date line from it.)
    await ann.ok('PATCH', '/api/auth/me', { timeZone: 'Pacific/Kiritimati' })
    const made = await ann.ok('POST', '/api/boards', { name: 'Store orders', template: 'store' })
    expect(made.added).toEqual(['Order total', 'Shipping', 'Client', 'Tracking number', ...CLIENTS])
    const { data } = await load(ann, made.id)
    expect(data.board).toMatchObject({ name: 'Store orders', mode: 'manual' })
    expect(data.columns.map((c: { name: string; category: string }) => `${c.name}:${c.category}`)).toEqual([
      'New:todo',
      'Packing:doing',
      'Packed:doing',
      'Shipped:done',
    ])
    expect(data.labels.map((l: { name: string }) => l.name).sort()).toEqual(['Gift', 'Made to order', 'Wholesale'])
    const [total, shipping] = data.fields
    expect(total).toMatchObject({ type: 'number', unit: '$', decimals: 2, sum: true, front: true, total: true })
    expect(shipping).toMatchObject({ type: 'choice', front: true })
    const cards = cardsOf(data)
    const orders = cards.filter((c) => !c.parentId)
    expect(orders).toHaveLength(5)
    const cafe = orders.find((c) => c.title.includes('Blue Harbor'))!
    const items = cards.filter((c) => c.parentId === cafe.id)
    expect(items.map((c) => c.status).sort()).toEqual(['new', 'shipped'])
    expect(items.find((c) => c.status === 'shipped')!.doneAt).toBeTruthy()
    expect(items.every((c) => !c.custom)).toBe(true)
    expect(cards.every((c) => !c.assigneeId)).toBe(true)
    // Today where she is.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date())
    expect(orders.filter((c) => c.due === today).length).toBeGreaterThan(0)
    const { presets } = await ann.ok('GET', `/api/boards/${made.id}/presets`)
    expect(presets.map((p: { name: string }) => p.name)).toEqual(['Leaves today', 'Late', 'By ship-by date (Outline)'])
    expect(presets[0].settings.filter).toEqual({ dueIs: { on: 'today' } })
    expect(presets[1].settings.filter).toEqual({ due: 'overdue' })
    // Search cards agrees, asked from where she is: something leaves today, and something is late.
    const leaves = await ann.ok('GET', `/api/cards?state=active&board=${made.id}&due=today&timeZone=Pacific/Kiritimati`)
    expect(leaves.cards.length).toBeGreaterThan(0)
    expect(leaves.cards.every((c: { due: string }) => c.due === today)).toBe(true)
    const late = await ann.ok('GET', `/api/cards?state=active&board=${made.id}&due=overdue&timeZone=Pacific/Kiritimati`)
    expect(late.cards.length).toBeGreaterThan(0)
  })

  it('bookings: a time of day on the owner’s clock, with whom, and only what’s finished is given to them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    await ann.ok('PATCH', '/api/auth/me', { timeZone: 'Asia/Bangkok' })
    const made = await ann.ok('POST', '/api/boards', { name: 'Bookings', template: 'bookings' })
    expect(made.added).toEqual(['Service', 'Price', 'Client', 'Deposit paid', ...CLIENTS])
    const { data } = await load(ann, made.id)
    expect(data.board).toMatchObject({ name: 'Bookings', mode: 'manual' })
    expect(data.columns.map((c: { name: string; category: string }) => `${c.name}:${c.category}`)).toEqual([
      'Booked:todo',
      'Arrived:doing',
      'Done:done',
      'No-show:done',
    ])
    const cards = cardsOf(data)
    expect(cards).toHaveLength(5)
    // Half past nine in Bangkok is half past two at night in UTC.
    const done = cards.find((c) => c.title === 'Mai Tran: cut')!
    expect(done).toMatchObject({ status: 'done', assigneeId: ann.user.id })
    expect(done.due).toMatch(/T02:30:00Z$/)
    expect(done.doneAt).toBeTruthy()
    expect(cards.filter((c) => c.assigneeId).map((c) => c.title)).toEqual(['Mai Tran: cut'])
    for (const c of cards) expect(c.due, c.title).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/)
    const { presets } = await ann.ok('GET', `/api/boards/${made.id}/presets`)
    expect(presets.map((p: { name: string }) => p.name)).toEqual(['Today', 'This week', 'Mine', 'The day in order (Outline)'])
    expect(presets[0].settings.filter).toEqual({ dueIs: { on: 'today' } })
    expect(presets[2].settings.filter).toEqual({ assignees: ['me'] })
    // The Outline's columns come in the order the starter put them, naming the library's fields.
    const [service, price] = data.fields
    const order = presets[3].settings.outline.order as string[]
    expect(order.slice(0, 4)).toEqual(['due', `f:${service.id}`, 'assignee', `f:${price.id}`])
    expect(JSON.stringify(presets)).not.toMatch(/st-/)
    // Nothing open is hers, so her morning email has nothing to say about them.
    const mine = await ann.ok('GET', `/api/cards?state=active&board=${made.id}&assignee=me&completed=false`)
    expect(mine.cards).toEqual([])
  })

  it('the starters after the first share its clients: the same board, and a client’s card by name', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const sales = await ann.ok('POST', '/api/boards', { name: 'Sales pipeline', template: 'sales' })
    const clientsId = sales.clients.id
    const before = cardsOf((await load(ann, clientsId)).data)
    // The shop's customers are clients already: every order is linked to one, and nothing is added to the board.
    const store = await ann.ok('POST', '/api/boards', { name: 'Store orders', template: 'store' })
    expect(store).toMatchObject({ added: ['Order total', 'Shipping', 'Tracking number'], clients: { id: clientsId, made: false } })
    const { data } = await load(ann, store.id)
    const client = data.fields.find((f: { name: string }) => f.name === 'Client')
    expect(client).toMatchObject({ board: clientsId })
    const orders = cardsOf(data).filter((c) => !c.parentId)
    const cafe = before.find((c) => c.title === 'Blue Harbor Cafe')!
    expect(orders.find((c) => c.title.includes('Blue Harbor'))!.custom![client.id]).toEqual([`${clientsId}:${cafe.id}`])
    expect(orders.filter((c) => c.custom?.[client.id])).toHaveLength(5)
    expect(cardsOf((await load(ann, clientsId)).data)).toHaveLength(before.length)

    // A client's card that was put away or deleted isn't linked, and isn't made again: the board is hers now. One
    // she added herself is found by its name, whatever its case.
    await mutate(ann, clientsId, { type: 'task.archive', id: cafe.id })
    await mutate(ann, clientsId, { type: 'task.delete', id: before.find((c) => c.title === 'Dana Keller')!.id })
    await mutate(ann, clientsId, { type: 'task.create', id: 'dana', parentId: null, fields: { title: 'dana KELLER', status: 'clients' } })
    const second = await ann.ok('POST', '/api/boards', { name: 'Second shop', template: 'store' })
    const its = cardsOf((await load(ann, second.id)).data).filter((c) => !c.parentId)
    expect(its.find((c) => c.title.includes('Blue Harbor'))!.custom?.[client.id]).toBeUndefined()
    expect(its.find((c) => c.title.includes('Dana Keller'))!.custom![client.id]).toEqual([`${clientsId}:dana`])
    expect(cardsOf((await load(ann, clientsId)).data)).toHaveLength(before.length - 1)

    // The board of clients archived: the field has nothing to pick from, and the board is made without its links.
    await ann.ok('POST', `/api/boards/${clientsId}/archive`, { archived: true })
    const third = await ann.ok('POST', '/api/boards', { name: 'Third', template: 'bookings' })
    expect(third.clients).toBeUndefined()
    const last = (await load(ann, third.id)).data
    expect(names(last.fields)).toContain('Client')
    expect(cardsOf(last).every((c) => !c.custom?.[client.id])).toBe(true)
    expect((await boardsOf(ann)).filter((b) => b.name === 'Clients')).toHaveLength(0)
  })

  it('a Client field of your own is used as it is: one that links elsewhere, or one you archived', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    // Hers links to any card she can reach, not to one board.
    const own = await ann.ok('POST', '/api/fields', { name: 'Client', type: 'link' })
    const made = await ann.ok('POST', '/api/boards', { name: 'Sales pipeline', template: 'sales' })
    expect(made.added).toEqual(['Deal value', 'Contact email', 'Close date', 'Source'])
    expect(made.clients).toBeUndefined()
    const { data } = await load(ann, made.id)
    expect(data.fields.find((f: { name: string }) => f.name === 'Client').id).toBe(own.id)
    expect(cardsOf(data).every((c) => !c.custom?.[own.id])).toBe(true)
    expect((await boardsOf(ann)).map((b) => b.name)).toEqual(['Sales pipeline'])
    // Archived: the board comes without it, and no board of clients is made for a field that isn't there.
    await ann.ok('PATCH', `/api/fields/${own.id}`, { archived: true })
    const next = await ann.ok('POST', '/api/boards', { name: 'Support desk', template: 'support' })
    expect(next).toMatchObject({ leftOut: ['Client'] })
    expect(next.clients).toBeUndefined()
    expect(next.added).not.toContain('Email')
    expect((await boardsOf(ann)).map((b) => b.name).sort()).toEqual(['Sales pipeline', 'Support desk'])
  })

  it('in a workspace: a member can’t make the first one (nothing is made), and can once an admin has', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const refused = await bob.request('POST', '/api/boards', { name: 'Deals', template: 'sales', workspaceId: ws })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe(
      'This starter needs fields that Acme doesn’t have yet: “Deal value”, “Client”, “Contact email”, “Close date”, “Source”, “Email”, “Phone”. Only the workspace’s admins can add fields: ask one to make the first board from this starter, or make yours in Personal.',
    )
    const inSpace = async (p: Person) => (await boardsOf(p)).filter((b) => b.workspaceId === ws)
    expect(await inSpace(bob)).toEqual([])
    expect((await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields).toEqual([])
    // Two admins' boards made at the same moment add one set of fields, and one board of clients.
    const both = await Promise.all([
      ann.ok('POST', '/api/boards', { name: 'Deals', template: 'sales', workspaceId: ws }),
      ann.ok('POST', '/api/boards', { name: 'More deals', template: 'sales', workspaceId: ws }),
    ])
    expect(both.map((b) => b.added.length).sort()).toEqual([0, 7])
    expect(both.map((b) => b.clients.made).sort()).toEqual([false, true])
    expect(both[0].clients.id).toBe(both[1].clients.id)
    expect(names((await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields)).toEqual([...SALES, ...CLIENTS])
    expect((await inSpace(ann)).map((b) => b.name).sort()).toEqual(['Clients', 'Deals', 'More deals'])
    // The member's board uses them, and links the workspace's clients, which he can open like its other boards.
    const his = await bob.ok('POST', '/api/boards', { name: 'Bob’s deals', template: 'sales', workspaceId: ws })
    expect(his).toMatchObject({ added: [], clients: { id: both[0].clients.id, made: false } })
    const { data } = await load(bob, his.id)
    expect(names(data.fields)).toEqual(SALES)
    const client = data.fields[1]
    expect(cardsOf(data).every((c) => (c.custom?.[client.id] as string[] | undefined)?.length === 1)).toBe(true)
    // He still can't make the other starters there (each needs fields of its own), and can in Personal.
    expect((await bob.request('POST', '/api/boards', { name: 'Help', template: 'support', workspaceId: ws })).status).toBe(403)
    expect((await bob.request('POST', '/api/boards', { name: 'Shop', template: 'store', workspaceId: ws })).status).toBe(403)
    expect((await bob.ok('POST', '/api/boards', { name: 'Help', template: 'support' })).added).toHaveLength(7)
    // A board of clients he can't open isn't linked to: the cards come without a client, and nothing says where it is.
    await ann.ok('PATCH', `/api/boards/${both[0].clients.id}/sharing`, { visibility: 'invited' })
    const blind = await bob.ok('POST', '/api/boards', { name: 'Later deals', template: 'sales', workspaceId: ws })
    expect(blind.clients).toBeUndefined()
    expect(cardsOf((await load(bob, blind.id)).data).every((c) => !c.custom?.[client.id])).toBe(true)
  })

  it('uses the library’s fields as they are: an archived one stays off, one changed isn’t touched', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const first = await ann.ok('POST', '/api/boards', { name: 'One', template: 'sales' })
    const lib = (await ann.ok('GET', '/api/fields')).fields as {
      id: string
      name: string
      options?: { id: string; name: string; color: string; archived?: boolean }[]
    }[]
    const by = (name: string) => lib.find((f) => f.name === name)!
    await ann.ok('PATCH', `/api/fields/${by('Contact email').id}`, { archived: true })
    // Source: Event is put away and then deleted for good; Website is renamed.
    const source = by('Source')
    const options = source.options!.map((o) => ({
      ...o,
      ...(o.name === 'Event' && { archived: true }),
      ...(o.name === 'Website' && { name: 'Web' }),
    }))
    await ann.ok('PATCH', `/api/fields/${source.id}`, { options })
    await ann.ok('PATCH', `/api/fields/${source.id}`, { options: options.filter((o) => o.name !== 'Event') })
    // A text field took the name of one the starter has as a date.
    await ann.ok('PATCH', `/api/fields/${by('Close date').id}`, { name: 'Expected close' })
    await ann.ok('POST', '/api/fields', { name: 'Close date', type: 'text' })

    const made = await ann.ok('POST', '/api/boards', { name: 'Two', template: 'sales' })
    expect(made).toMatchObject({ added: ['Close date (2)'], leftOut: ['Contact email'] })
    const { data } = await load(ann, made.id)
    expect(names(data.fields)).toEqual(['Deal value', 'Client', 'Close date (2)', 'Source'])
    const now = (await ann.ok('GET', '/api/fields')).fields.find((f: { id: string }) => f.id === source.id)
    expect(now.options.map((o: { name: string }) => o.name)).toEqual(['Referral', 'Web', 'Outreach'])
    const cards = cardsOf(data)
    // The card that came from the website still says so (the option was only renamed); the one from an event says nothing.
    expect(cards.find((c) => c.title.startsWith('Northwind'))!.custom![source.id]).toEqual(['st-source-website'])
    expect(cards.find((c) => c.title.startsWith('Pinecrest'))!.custom![source.id]).toBeUndefined()
    expect(cards.every((c) => !(by('Contact email').id in c.custom!))).toBe(true)
    // The first board is as it was.
    expect((await load(ann, first.id)).data.fields.map((f: { name: string }) => f.name)).toEqual(['Deal value', 'Client', 'Expected close', 'Source'])
  })
})
