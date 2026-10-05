import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok('GET', `/api/boards/${id}`)
const SALES = ['Deal value', 'Company', 'Contact email', 'Close date', 'Source']
const names = (fields: { name: string }[]) => fields.map((f) => f.name)

describe('a board from a starter', () => {
  it('in Personal: its lists, fields, example cards and saved filters, with the fields added to your library once', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok('POST', '/api/boards', { name: 'Pipeline', template: 'sales', background: 'teal' })
    expect(made).toMatchObject({ added: SALES, leftOut: [] })
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
    expect(names(library)).toEqual(SALES)
    expect(data.fields.map((f: { id: string }) => f.id)).toEqual(library.map((f: { id: string }) => f.id))
    // The example cards hold values for those fields, and the one that was won says when.
    const cards = Object.values(data.tasks) as { title: string; status: string; custom: Record<string, unknown>; doneAt?: string }[]
    expect(cards).toHaveLength(5)
    const [value, company, , close, source] = data.fields
    const first = cards.find((c) => c.title.startsWith('Northwind'))!
    expect(first.custom).toMatchObject({ [value.id]: 12000, [company.id]: 'Northwind Traders', [source.id]: ['st-source-website'] })
    expect(String(first.custom[close.id])).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(cards.find((c) => c.status === 'won')!.doneAt).toBeTruthy()
    expect(JSON.stringify(data)).not.toMatch(/st-sales-/)
    // Its saved filters name the library's fields, in the starter's order.
    const { presets } = await ann.ok('GET', `/api/boards/${made.id}/presets`)
    expect(presets.map((p: { name: string }) => p.name)).toEqual(['Closing in the next 7 days', 'Deals of 10,000 and up'])
    expect(presets[0].settings).toMatchObject({ filter: { fields: { [close.id]: { date: 'week' } } }, display: { board: { filter: 'main' } } })
    expect(presets[1].settings.filter.fields).toEqual({ [value.id]: { min: 10000 } })
    expect(presets[0].by).toBe('Ann')

    // A second one adds nothing and uses the same fields. Someone else's has fields of their own.
    const again = await ann.ok('POST', '/api/boards', { name: 'Second', template: 'sales' })
    expect(again.added).toEqual([])
    expect((await load(ann, again.id)).data.fields.map((f: { id: string }) => f.id)).toEqual(library.map((f: { id: string }) => f.id))
    expect((await ann.ok('GET', '/api/fields')).fields).toHaveLength(5)
    const bob = await Person.signUp(t.app, 'Bob')
    const his = await bob.ok('POST', '/api/boards', { name: 'His', template: 'sales' })
    expect((await load(bob, his.id)).data.fields[0].id).not.toBe(value.id)
  })

  it('the support desk comes with labels, and a saved view sorted by a field', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok('POST', '/api/boards', { name: 'Help', template: 'support' })
    expect(made.added).toEqual(['Severity', 'Customer', 'Customer email', 'Channel', 'Reported on'])
    const { data } = await load(ann, made.id)
    expect(data.labels.map((l: { name: string }) => l.name).sort()).toEqual(['Billing', 'Bug', 'Question'])
    expect(data.columns.map((c: { name: string }) => c.name)).toEqual(['New', 'In progress', 'Waiting on customer', 'Solved'])
    const severity = data.fields[0]
    expect(severity).toMatchObject({ name: 'Severity', type: 'choice', front: true })
    const { presets } = await ann.ok('GET', `/api/boards/${made.id}/presets`)
    expect(presets[0].settings.filter.fields).toEqual({ [severity.id]: { in: ['st-severity-high', 'st-severity-critical'] } })
    expect(presets[1].settings.outline.sort).toEqual({ key: `f:${severity.id}`, dir: 'desc' })
  })

  it('in a workspace: a member can’t make the first one (nothing is made), and can once an admin has', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const refused = await bob.request('POST', '/api/boards', { name: 'Deals', template: 'sales', workspaceId: ws })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe(
      'This starter needs fields that Acme doesn’t have yet: “Deal value”, “Company”, “Contact email”, “Close date”, “Source”. Only the workspace’s admins can add fields: ask one to make the first board from this starter, or make yours in Personal.',
    )
    expect((await bob.ok('GET', '/api/boards')).boards.filter((b: { workspaceId: string | null }) => b.workspaceId === ws)).toEqual([])
    expect((await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields).toEqual([])
    // Two admins' boards made at the same moment add one set of fields.
    const both = await Promise.all([
      ann.ok('POST', '/api/boards', { name: 'Deals', template: 'sales', workspaceId: ws }),
      ann.ok('POST', '/api/boards', { name: 'More deals', template: 'sales', workspaceId: ws }),
    ])
    expect(both.map((b) => b.added.length).sort()).toEqual([0, 5])
    expect(names((await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields)).toEqual(SALES)
    const his = await bob.ok('POST', '/api/boards', { name: 'Bob’s deals', template: 'sales', workspaceId: ws })
    expect(his.added).toEqual([])
    expect(names((await load(bob, his.id)).data.fields)).toEqual(SALES)
    // He still can't make the other starter there, and can in Personal.
    expect((await bob.request('POST', '/api/boards', { name: 'Help', template: 'support', workspaceId: ws })).status).toBe(403)
    expect((await bob.ok('POST', '/api/boards', { name: 'Help', template: 'support' })).added).toHaveLength(5)
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
    await ann.ok('PATCH', `/api/fields/${by('Company').id}`, { archived: true })
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
    expect(made).toMatchObject({ added: ['Close date (2)'], leftOut: ['Company'] })
    const { data } = await load(ann, made.id)
    expect(names(data.fields)).toEqual(['Deal value', 'Contact email', 'Close date (2)', 'Source'])
    const now = (await ann.ok('GET', '/api/fields')).fields.find((f: { id: string }) => f.id === source.id)
    expect(now.options.map((o: { name: string }) => o.name)).toEqual(['Referral', 'Web', 'Outreach'])
    const cards = Object.values(data.tasks) as { title: string; custom: Record<string, unknown> }[]
    // The card that came from the website still says so (the option was only renamed); the one from an event says nothing.
    expect(cards.find((c) => c.title.startsWith('Northwind'))!.custom[source.id]).toEqual(['st-source-website'])
    expect(cards.find((c) => c.title.startsWith('Pinecrest'))!.custom[source.id]).toBeUndefined()
    expect(cards.every((c) => !(by('Company').id in c.custom))).toBe(true)
    // The first board is as it was.
    expect((await load(ann, first.id)).data.fields.map((f: { name: string }) => f.name)).toEqual([
      'Deal value',
      'Contact email',
      'Expected close',
      'Source',
    ])
  })
})
