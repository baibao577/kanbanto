import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardFieldRows, libraryFields, tasks } from '../src/db/schema'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok('GET', `/api/boards/${id}`)
const mutate = (p: Person, id: string, command: object) => p.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
/** The same, for a command that may be refused: the answer, whatever it is. */
const attempt = (p: Person, id: string, command: object) => p.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const set = (p: Person, id: string, taskId: string, custom: object) => mutate(p, id, { type: 'task.update', id: taskId, fields: { custom } })
/** What the database holds for a card, which can be more than a board shows. */
const stored = async (boardId: string, taskId: string) =>
  (
    await t.db
      .select({ custom: tasks.custom })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), eq(tasks.id, taskId)))
  )[0]?.custom
const pick = (p: Person, id: string, fields: { id: string; front?: boolean }[]) => p.ok('PUT', `/api/boards/${id}/fields`, { fields })

/** Ann, her example board in Personal, and three fields of her own: Company (text), Value (number), Stage (choice). */
async function crm() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const add = async (body: object) => (await ann.ok('POST', '/api/fields', body)).id as string
  const company = await add({ name: 'Company', type: 'text' })
  const value = await add({ name: 'Value', type: 'number', unit: '฿', decimals: 0, sum: true })
  const stage = await add({
    name: 'Stage',
    type: 'choice',
    options: [
      { name: 'Lead', color: 'gray' },
      { name: 'Won', color: 'green' },
    ],
  })
  const { fields } = await ann.ok('GET', '/api/fields')
  const [lead, won] = fields.find((f: { id: string }) => f.id === stage).options.map((o: { id: string }) => o.id)
  return { ann, id, company, value, stage, lead, won }
}

describe('a library of fields', () => {
  it('in a workspace: its admins manage it, everyone in it reads it', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const sue = await Person.signUp(t.app, 'Sue')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const base = `/api/workspaces/${ws}/fields`

    const made = await ann.ok('POST', base, { name: '  Stage ', type: 'choice', options: [{ name: 'Lead', color: 'gray' }] })
    expect(made.fields).toMatchObject([{ name: 'Stage', type: 'choice', options: [{ name: 'Lead', color: 'gray' }], archivedAt: null, boards: 0 }])
    expect(await bob.ok('GET', base)).toMatchObject({ canManage: false, fields: [{ name: 'Stage' }] })
    expect((await bob.request('POST', base, { name: 'Mine', type: 'text' })).status).toBe(403)
    expect((await bob.request('PATCH', `${base}/${made.id}`, { name: 'Mine' })).status).toBe(403)
    expect((await sue.request('GET', base)).status).toBe(404)

    // One name per library, whatever the case; nothing every card already has; and a type is for good.
    expect((await ann.request('POST', base, { name: 'stage', type: 'text' })).status).toBe(409)
    expect((await ann.request('POST', base, { name: 'Due', type: 'date' })).body.error).toMatch(/already has/)
    expect((await ann.request('POST', base, { name: ' ', type: 'text' })).status).toBe(400)
    expect((await ann.request('PATCH', `${base}/${made.id}`, { type: 'text' })).status).toBe(400)

    // Only what means something for the type is kept.
    const { id: value } = await ann.ok('POST', base, { name: 'Value', type: 'number', unit: ' ฿ ', decimals: 2, sum: true, format: 'link' })
    const { fields } = await ann.ok('PATCH', `${base}/${value}`, { name: 'Deal value', decimals: null })
    const row = fields.find((f: { id: string }) => f.id === value)
    expect(row).toMatchObject({ name: 'Deal value', unit: '฿', sum: true })
    expect(row).not.toHaveProperty('decimals')
    expect(row).not.toHaveProperty('format')

    // Yours are apart from the workspace's, and nobody else's business.
    await ann.ok('POST', '/api/fields', { name: 'Stage', type: 'text' })
    expect((await ann.ok('GET', '/api/fields')).fields).toMatchObject([{ name: 'Stage', type: 'text' }])
    expect((await bob.ok('GET', '/api/fields')).fields).toEqual([])

    // A workspace with no boards left can be deleted, fields and all.
    await ann.ok('DELETE', `/api/workspaces/${ws}`)
    expect(await t.db.select().from(libraryFields).where(eq(libraryFields.workspaceId, ws))).toEqual([])
  })

  it('holds 50 fields at most', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    for (let i = 0; i < 50; i++) await ann.ok('POST', '/api/fields', { name: `Field ${i}`, type: 'text' })
    const over = await ann.request('POST', '/api/fields', { name: 'One more', type: 'text' })
    expect(over.status).toBe(400)
    expect(over.body.error).toMatch(/50 fields at most/)
  })
})

describe('a board’s fields', () => {
  it('are picked by its owners, from their library, in an order, with up to three on the card front', async () => {
    const { ann, id, company, value, stage } = await crm()
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })

    expect(await ann.ok('GET', `/api/boards/${id}/fields`)).toMatchObject({ fields: [], canPick: true, canManage: true, workspace: null })
    expect((await ann.ok('GET', `/api/boards/${id}/fields`)).available.map((f: { name: string }) => f.name)).toEqual(['Company', 'Value', 'Stage'])
    const before = (await load(ann, id)).seq
    const picked = await pick(ann, id, [{ id: value, front: true }, { id: company }])
    expect(picked.fields).toMatchObject([{ name: 'Value', type: 'number', unit: '฿', front: true }, { name: 'Company' }])
    expect(picked.available.map((f: { name: string }) => f.name)).toEqual(['Stage'])
    const board = await load(ann, id)
    expect(board.data.fields.map((f: { name: string }) => f.name)).toEqual(['Value', 'Company'])
    expect(board.seq).toBeGreaterThan(before)
    expect((await ann.ok('GET', '/api/fields')).fields.map((f: { boards: number }) => f.boards)).toEqual([1, 1, 0])

    // An editor sees them, and can't choose them; nor see the owner's library.
    expect(await bob.ok('GET', `/api/boards/${id}/fields`)).toMatchObject({ canPick: false, canManage: false, available: [] })
    expect((await bob.request('PUT', `/api/boards/${id}/fields`, { fields: [] })).status).toBe(403)

    // Not twice, not someone else's, not one that isn't there, and three on the front at most.
    const { id: bobs } = await bob.ok('POST', '/api/fields', { name: 'Bob’s own', type: 'text' })
    const no = async (fields: object[]) => (await ann.request('PUT', `/api/boards/${id}/fields`, { fields })).status
    expect(await no([{ id: value }, { id: value }])).toBe(400)
    expect(await no([{ id: bobs }])).toBe(400)
    expect(await no([{ id: '01900000-0000-7000-8000-000000000000' }])).toBe(400)
    const { id: a } = await ann.ok('POST', '/api/fields', { name: 'A', type: 'text' })
    expect(await no([value, company, stage, a].map((f) => ({ id: f, front: true })))).toBe(400)

    // What changed is in the board's activity.
    await pick(ann, id, [{ id: company }])
    const log = (await ann.ok('GET', `/api/boards/${id}/activity`)).activity.flatMap(
      (e: { items?: { text: string }[] }) => e.items?.map((i) => i.text) ?? [],
    )
    expect(log).toEqual(expect.arrayContaining(['added the field “Value”', 'added the field “Company”', 'took the field “Value” off the board']))
  })

  it('in a workspace come from the workspace’s library, not from anyone’s own', async () => {
    const { ann, company } = await crm()
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const { id: shared } = await ann.ok('POST', `/api/workspaces/${ws}/fields`, { name: 'Customer', type: 'text' })
    // Bob (a member, not an admin) makes a board there: he picks its fields, but can't add to the library.
    const { id } = await bob.ok('POST', '/api/boards', { name: 'Support', workspaceId: ws })
    expect(await bob.ok('GET', `/api/boards/${id}/fields`)).toMatchObject({
      canPick: true,
      canManage: false,
      workspace: { id: ws, name: 'Acme' },
      available: [{ name: 'Customer' }],
    })
    expect((await pick(bob, id, [{ id: shared }])).fields).toMatchObject([{ name: 'Customer' }])
    const { id: own } = await bob.ok('POST', '/api/fields', { name: 'Mine', type: 'text' })
    expect((await bob.request('PUT', `/api/boards/${id}/fields`, { fields: [{ id: own }] })).status).toBe(400)
    expect((await ann.request('PUT', `/api/boards/${id}/fields`, { fields: [{ id: company }] })).status).toBe(403)
    // Renaming it in the library renames it on the board.
    await ann.ok('PATCH', `/api/workspaces/${ws}/fields/${shared}`, { name: 'Client' })
    expect((await load(bob, id)).data.fields).toMatchObject([{ id: shared, name: 'Client' }])
  })
})

describe('a total in lists', () => {
  it('is switched on per board, for numbers that add up, three at most', async () => {
    const { ann, id, company, value } = await crm()
    const { id: score } = await ann.ok('POST', '/api/fields', { name: 'Score', type: 'number' })
    const sums = []
    for (const name of ['Hours', 'Cost', 'Tax']) sums.push((await ann.ok('POST', '/api/fields', { name, type: 'number', sum: true })).id as string)
    const put = (fields: object[]) => ann.request('PUT', `/api/boards/${id}/fields`, { fields })

    expect((await put([{ id: value, total: true }, { id: company }])).body.fields).toMatchObject([
      { name: 'Value', total: true },
      { name: 'Company' },
    ])
    expect((await load(ann, id)).data.fields[0]).toMatchObject({ name: 'Value', total: true })
    expect((await put([{ id: company, total: true }])).body.error).toMatch(/isn’t a number that adds up/)
    expect((await put([{ id: score, total: true }])).body.error).toMatch(/isn’t a number that adds up/)
    expect((await put([value, ...sums].map((f) => ({ id: f, total: true })))).body.error).toMatch(/Up to 3 fields can have a total/)
    // If the library later says the number doesn't add up after all, the board's total goes quiet (and comes back).
    await ann.ok('PATCH', `/api/fields/${value}`, { sum: false })
    expect((await load(ann, id)).data.fields[0]).not.toHaveProperty('total')
    await ann.ok('PATCH', `/api/fields/${value}`, { sum: true })
    expect((await load(ann, id)).data.fields[0]).toMatchObject({ total: true })
    // Taken off the board and added again, it starts without one.
    await put([{ id: company }])
    expect((await put([{ id: value }, { id: company }])).body.fields[0]).not.toHaveProperty('total')
  })
})

describe('values on cards', () => {
  it('are checked against the field, saved, and logged', async () => {
    const { ann, id, company, value, stage, won } = await crm()
    await pick(ann, id, [{ id: company }, { id: value }, { id: stage }])
    await set(ann, id, 'A3', { [company]: ' Acme ', [value]: 12000, [stage]: won })
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [company]: 'Acme', [value]: 12000, [stage]: [won] })
    t.app.engine.forget(id)
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [company]: 'Acme', [value]: 12000, [stage]: [won] })

    const bad = await ann.request('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A3', fields: { custom: { [value]: 'lots' } } },
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toBe('Value: That isn’t a number.')
    const log = (await ann.ok('GET', `/api/boards/${id}/activity`)).activity.flatMap(
      (e: { items?: { text: string }[] }) => e.items?.map((i) => i.text) ?? [],
    )
    expect(log).toEqual(
      expect.arrayContaining(['set Company of “Deploy” to Acme', 'set Value of “Deploy” to ฿12,000', 'set Stage of “Deploy” to Won']),
    )
  })

  it('stay on the server when their field leaves the board, and are back when it returns', async () => {
    const { ann, id, company, value } = await crm()
    await pick(ann, id, [{ id: company }, { id: value }])
    await set(ann, id, 'A3', { [company]: 'Acme', [value]: 5 })
    await ann.ok('PATCH', `/api/boards/${id}/sharing`, { publicLink: true })
    const visitor = new Person(t.app)

    await pick(ann, id, [{ id: value }])
    // Nobody is sent the hidden value: not the owner, not a visitor with the link.
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [value]: 5 })
    const seen = await load(visitor, id)
    expect(seen.data.fields.map((f: { name: string }) => f.name)).toEqual(['Value'])
    expect(JSON.stringify(seen)).not.toContain('Acme')
    expect(await visitor.ok('GET', `/api/boards/${id}/fields`)).toMatchObject({ canPick: false, available: [], workspace: null })
    // It's still in the database, and stays there through other edits of the card, and through an undo.
    expect(await stored(id, 'A3')).toEqual({ [company]: 'Acme', [value]: 5 })
    const now = (await load(ann, id)).data.tasks.A3
    await set(ann, id, 'A3', { [value]: 6 })
    const then = (await load(ann, id)).data.tasks.A3
    await mutate(ann, id, {
      type: 'records.restore',
      changes: [{ entity: 'task', id: 'A3', before: then, after: { ...now, custom: { [company]: 'Other', [value]: 5 } } }],
    })
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [value]: 5 })
    expect(await stored(id, 'A3')).toEqual({ [company]: 'Acme', [value]: 5 })
    // A value for a field the board doesn't use is refused.
    expect(
      (
        await ann.request('POST', `/api/boards/${id}/mutations`, {
          mutationId: mid(),
          command: { type: 'task.update', id: 'A3', fields: { custom: { [company]: 'x' } } },
        })
      ).status,
    ).toBe(422)

    await pick(ann, id, [{ id: value }, { id: company }])
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [company]: 'Acme', [value]: 5 })
  })

  it('can be cleared on every card by an editor, and that can be undone', async () => {
    const { ann, id, value } = await crm()
    const bob = await Person.signUp(t.app, 'Bob')
    await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
    await pick(ann, id, [{ id: value }])
    await set(ann, id, 'A3', { [value]: 1 })
    await set(ann, id, 'A1', { [value]: 2 })
    const { changes } = await mutate(bob, id, { type: 'tasks.clearField', fieldId: value })
    expect(changes).toHaveLength(2)
    const cleared = (await load(ann, id)).data.tasks
    expect([cleared.A3.custom, cleared.A1.custom, await stored(id, 'A3')]).toEqual([undefined, undefined, null])
    const log = (await ann.ok('GET', `/api/boards/${id}/activity`)).activity.flatMap(
      (e: { items?: { text: string }[] }) => e.items?.map((i) => i.text) ?? [],
    )
    expect(log).toContain('cleared Value on 2 cards')
    // Undo, as the app does it: the records put back as they were.
    await mutate(bob, id, {
      type: 'records.restore',
      changes: changes.map((c: { before: object; after: object }) => ({ ...c, before: c.after, after: c.before })),
    })
    expect((await load(ann, id)).data.tasks.A1.custom).toEqual({ [value]: 2 })
  })
})

describe('archiving and deleting a field', () => {
  it('archived: hidden on every board, values kept; deleted for good: gone from every card, and undo can’t bring it back', async () => {
    const { ann, id, company, value } = await crm()
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Second', template: 'example' })
    for (const b of [id, other]) {
      await pick(ann, b, [{ id: company }, { id: value }])
      await set(ann, b, 'A3', { [company]: 'Acme', [value]: 1 })
    }
    const withValue = (await load(ann, id)).data.tasks.A3
    expect(await ann.ok('GET', `/api/fields/${company}/usage`)).toEqual({ boards: 2, cards: 2 })
    expect((await ann.request('DELETE', `/api/fields/${company}`)).body.error).toMatch(/Archive it first/)

    const before = (await load(ann, other)).seq
    const { fields } = await ann.ok('PATCH', `/api/fields/${company}`, { archived: true })
    expect(fields.find((f: { id: string }) => f.id === company).archivedAt).not.toBeNull()
    for (const b of [id, other]) {
      const board = await load(ann, b)
      expect(board.data.fields.map((f: { name: string }) => f.name)).toEqual(['Value'])
      expect(board.data.tasks.A3.custom).toEqual({ [value]: 1 })
    }
    expect((await load(ann, other)).seq).toBeGreaterThan(before)
    // Its name is still taken, and an archived field isn't offered to boards.
    expect((await ann.request('POST', '/api/fields', { name: 'company', type: 'text' })).body.error).toMatch(/archived field called “Company”/)
    expect((await ann.ok('GET', `/api/boards/${id}/fields`)).available.map((f: { name: string }) => f.name)).toEqual(['Stage'])

    // Restored: back on both boards, where it was, with its values.
    await ann.ok('PATCH', `/api/fields/${company}`, { archived: false })
    expect((await load(ann, other)).data.fields.map((f: { name: string }) => f.name)).toEqual(['Company', 'Value'])
    expect((await load(ann, other)).data.tasks.A3.custom).toEqual({ [company]: 'Acme', [value]: 1 })

    await ann.ok('PATCH', `/api/fields/${company}`, { archived: true })
    expect((await ann.ok('DELETE', `/api/fields/${company}`)).fields.map((f: { name: string }) => f.name)).toEqual(['Value', 'Stage'])
    expect([await stored(id, 'A3'), await stored(other, 'A3')]).toEqual([{ [value]: 1 }, { [value]: 1 }])
    expect(await t.db.select().from(boardFieldRows).where(eq(boardFieldRows.fieldId, company))).toEqual([])
    // An undo that was made while the card still had the value names a field this board no longer knows: it's
    // refused, and the card stays as it is.
    const now = (await load(ann, id)).data.tasks.A3
    const undo = await attempt(ann, id, { type: 'records.restore', changes: [{ entity: 'task', id: 'A3', before: now, after: withValue }] })
    expect(undo.status).toBe(422)
    expect(undo.body.error).toBe('This board’s fields changed since, so it can’t be undone.')
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [value]: 1 })
    expect(await stored(id, 'A3')).toEqual({ [value]: 1 })
    // One that names nothing of the sort still goes through, and so does one with a made-up field (refused, not a crash).
    const { custom: _c, ...plain } = withValue
    expect(
      (
        await attempt(ann, id, {
          type: 'records.restore',
          changes: [{ entity: 'task', id: 'A3', before: now, after: { ...plain, custom: { [value]: 1 } } }],
        })
      ).status,
    ).toBe(200)
    const later = (await load(ann, id)).data.tasks.A3
    expect(
      (
        await attempt(ann, id, {
          type: 'records.restore',
          changes: [{ entity: 'task', id: 'A3', before: later, after: { ...later, custom: { nonsense: 'x' } } }],
        })
      ).status,
    ).toBe(422)
    // The name is free again.
    await ann.ok('POST', '/api/fields', { name: 'Company', type: 'text' })
  })

  it('a choice’s options go the same two steps: archived (cards keep it, nobody picks it), then deleted', async () => {
    const { ann, id, stage, lead, won } = await crm()
    await pick(ann, id, [{ id: stage }])
    await set(ann, id, 'A3', { [stage]: won })
    await set(ann, id, 'A1', { [stage]: lead })
    const options = (extra: object[]) =>
      ann.request('PATCH', `/api/fields/${stage}`, { options: [{ id: lead, name: 'Lead', color: 'gray' }, ...extra] })
    expect((await options([])).body.error).toMatch(/Archive “Won” first/)
    expect(
      (
        await options([
          { id: won, name: 'Won', color: 'green', archived: true },
          { name: 'lead', color: 'red' },
        ])
      ).body.error,
    ).toMatch(/two options called/)

    expect(
      (
        await options([
          { id: won, name: 'Closed', color: 'green', archived: true },
          { name: 'Lost', color: 'red' },
        ])
      ).status,
    ).toBe(200)
    const board = await load(ann, id)
    expect(board.data.fields[0].options).toMatchObject([{ name: 'Lead' }, { name: 'Closed', archived: true }, { name: 'Lost' }])
    expect(board.data.tasks.A3.custom).toEqual({ [stage]: [won] })
    const again = await ann.request('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'A1', fields: { custom: { [stage]: won } } },
    })
    expect(again.body.error).toMatch(/“Closed” can’t be picked any more/)

    const lost = board.data.fields[0].options[2].id
    expect((await options([{ id: lost, name: 'Lost', color: 'red' }])).status).toBe(200)
    const after = await load(ann, id)
    expect(after.data.tasks.A3.custom).toBeUndefined()
    expect(after.data.tasks.A1.custom).toEqual({ [stage]: [lead] })
    expect(await stored(id, 'A3')).toBeNull()
  })
})

describe('fields when things move', () => {
  it('a card moving to another board takes the values that board has a field for, and says what it leaves', async () => {
    const { ann, id, company, value, stage, won } = await crm()
    await pick(ann, id, [{ id: company }, { id: value }, { id: stage }])
    await set(ann, id, 'A3', { [company]: 'Acme', [value]: 5, [stage]: won })
    // A second board of hers uses Company (the same field); a workspace board has its own "company" and "Stage".
    const { id: second } = await ann.ok('POST', '/api/boards', { name: 'Second' })
    await pick(ann, second, [{ id: company }])
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    const { id: wsCompany } = await ann.ok('POST', `/api/workspaces/${ws}/fields`, { name: 'company', type: 'text' })
    const { id: wsStage, fields } = await ann.ok('POST', `/api/workspaces/${ws}/fields`, {
      name: 'Stage',
      type: 'choice',
      options: [{ name: 'WON', color: 'green' }],
    })
    const wsWon = fields.find((f: { id: string }) => f.id === wsStage).options[0].id
    const { id: team } = await ann.ok('POST', '/api/boards', { name: 'Team', workspaceId: ws })
    await pick(ann, team, [{ id: wsCompany }, { id: wsStage }])

    const a = await ann.ok('POST', `/api/boards/${id}/tasks/A3/move`, { boardId: second })
    expect(a.summary.droppedFields.sort()).toEqual(['Stage', 'Value'])
    expect((await load(ann, second)).data.tasks[a.id].custom).toEqual({ [company]: 'Acme' })
    expect(await stored(second, a.id)).toEqual({ [company]: 'Acme' })

    await set(ann, id, 'A1', { [company]: 'Beta', [value]: 7, [stage]: won })
    const b = await ann.ok('POST', `/api/boards/${id}/tasks/A1/move`, { boardId: team })
    expect(b.summary.droppedFields).toEqual(['Value'])
    expect((await load(ann, team)).data.tasks[b.id].custom).toEqual({ [wsCompany]: 'Beta', [wsStage]: [wsWon] })
  })

  it('a board moving to another space asks before fields are added there or lost, then takes its values along', async () => {
    const { ann, id, company, value, stage, lead, won } = await crm()
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: extra } = await ann.ok('POST', '/api/fields', { name: 'Extra', type: 'text' })
    await pick(ann, id, [{ id: stage, front: true }, { id: company }, { id: value }, { id: extra }])
    await set(ann, id, 'A3', { [company]: 'Acme', [value]: 5, [stage]: won, [extra]: 'hidden soon' })
    await set(ann, id, 'A1', { [stage]: lead })
    await pick(ann, id, [{ id: stage, front: true }, { id: company }, { id: value }])
    // A saved filter that names the fields, to see it follow them.
    await ann.ok('POST', `/api/boards/${id}/presets`, {
      name: 'Big ones',
      settings: {
        display: { board: { columns: 'status', rows: 'none', filter: 'all', parentDisplay: [] } },
        outline: { sort: { key: `f:${value}`, dir: 'desc' }, order: [`f:${value}`, 'due', `f:${company}`] },
        filter: {
          assignees: ['me'],
          dueIs: { on: 'this-month' },
          fields: { [company]: { text: 'ac' }, [stage]: { notIn: [lead] }, [value]: { min: 1 } },
        },
      },
    })

    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const { id: wsCompany } = await ann.ok('POST', `/api/workspaces/${ws}/fields`, { name: 'COMPANY', type: 'text' })
    const { id: wsStage, fields: lib } = await ann.ok('POST', `/api/workspaces/${ws}/fields`, {
      name: 'Stage',
      type: 'choice',
      options: [{ name: 'Lead', color: 'gray' }],
    })
    const wsLead = lib.find((f: { id: string }) => f.id === wsStage).options[0].id

    const old = (await load(ann, id)).data.tasks.A3
    // Asked first: Value isn't there, and neither is Stage's "Won".
    const asked = await ann.request('PUT', `/api/boards/${id}/workspace`, { workspaceId: ws })
    expect(asked.status).toBe(409)
    expect(asked.body).toMatchObject({ code: 'fields', add: ['Value', 'Stage: Won'], lose: [] })
    expect((await load(ann, id)).data.fields.map((f: { id: string }) => f.id)).toEqual([stage, company, value])

    await ann.ok('PUT', `/api/boards/${id}/workspace`, { workspaceId: ws, confirm: true })
    const library = (await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields
    const wsValue = library.find((f: { name: string }) => f.name === 'Value')
    const wsWon = library.find((f: { id: string }) => f.id === wsStage).options[1]
    expect(wsValue).toMatchObject({ type: 'number', unit: '฿', sum: true, boards: 1 })
    expect(wsWon).toMatchObject({ name: 'Won', color: 'green' })
    const moved = await load(ann, id)
    expect(moved.data.fields).toMatchObject([{ id: wsStage, front: true }, { id: wsCompany }, { id: wsValue.id }])
    expect(moved.data.tasks.A3.custom).toEqual({ [wsCompany]: 'Acme', [wsValue.id]: 5, [wsStage]: [wsWon.id] })
    expect(moved.data.tasks.A1.custom).toEqual({ [wsStage]: [wsLead] })
    // What was hidden on the board didn't move with it.
    expect(Object.keys((await stored(id, 'A3'))!).sort()).toEqual([wsCompany, wsValue.id, wsStage].sort())
    // Its saved filter names the fields it has now, their options too, and still says the rest.
    const [kept] = (await ann.ok('GET', `/api/boards/${id}/presets`)).presets
    expect(kept.settings.filter).toEqual({
      assignees: ['me'],
      dueIs: { on: 'this-month' },
      fields: { [wsCompany]: { text: 'ac' }, [wsStage]: { notIn: [wsLead] }, [wsValue.id]: { min: 1 } },
    })
    expect(kept.settings.outline).toEqual({ sort: { key: `f:${wsValue.id}`, dir: 'desc' }, order: [`f:${wsValue.id}`, 'due', `f:${wsCompany}`] })
    // An undo from before the move names the fields the board had then: it's refused, and wipes nothing.
    const undo = await attempt(ann, id, {
      type: 'records.restore',
      changes: [
        { entity: 'task', id: 'A3', before: moved.data.tasks.A3, after: { ...old, title: 'As it was', version: moved.data.tasks.A3.version + 1 } },
      ],
    })
    expect(undo.body.error).toBe('This board’s fields changed since, so it can’t be undone.')
    expect((await load(ann, id)).data.tasks.A3.custom).toEqual({ [wsCompany]: 'Acme', [wsValue.id]: 5, [wsStage]: [wsWon.id] })
    // Her own fields are no longer used by it.
    expect((await ann.ok('GET', '/api/fields')).fields.map((f: { boards: number }) => f.boards)).toEqual([0, 0, 0, 0])

    // Someone who doesn't manage the library can't add to it: what it lacks is lost, and they're told first.
    const [{ id: bobs }] = (await bob.ok('GET', '/api/boards')).boards
    const { id: budget } = await bob.ok('POST', '/api/fields', { name: 'Budget', type: 'number' })
    const { id: bobCompany } = await bob.ok('POST', '/api/fields', { name: 'Company', type: 'text' })
    await pick(bob, bobs, [{ id: budget }, { id: bobCompany }])
    await set(bob, bobs, 'A3', { [budget]: 9, [bobCompany]: 'Zed' })
    expect((await bob.request('PUT', `/api/boards/${bobs}/workspace`, { workspaceId: ws })).body).toMatchObject({
      code: 'fields',
      add: [],
      lose: ['Budget'],
    })
    await bob.ok('PUT', `/api/boards/${bobs}/workspace`, { workspaceId: ws, confirm: true })
    expect((await load(bob, bobs)).data.tasks.A3.custom).toEqual({ [wsCompany]: 'Zed' })
    expect((await ann.ok('GET', `/api/workspaces/${ws}/fields`)).fields.map((f: { name: string }) => f.name)).toEqual(['COMPANY', 'Stage', 'Value'])

    // Back to Personal: her own library has all three (and both options), so there's nothing to ask.
    await ann.ok('PUT', `/api/boards/${id}/workspace`, { workspaceId: null })
    const back = await load(ann, id)
    expect(back.data.fields.map((f: { id: string }) => f.id)).toEqual([stage, company, value])
    expect(back.data.tasks.A3.custom).toEqual({ [company]: 'Acme', [value]: 5, [stage]: [won] })
  })

  it('an exported board carries its fields; importing it makes them yours, once', async () => {
    const { ann, id, company, value, stage, won } = await crm()
    await pick(ann, id, [{ id: company, front: true }, { id: value }, { id: stage }])
    await set(ann, id, 'A3', { [company]: 'Acme', [value]: 5, [stage]: won })
    await mutate(ann, id, { type: 'task.archive', id: 'A1' })
    const file = { app: 'kanbanto', format: 3, data: (await ann.ok('GET', `/api/boards/${id}?archived=all`)).data }

    const bob = await Person.signUp(t.app, 'Bob')
    await bob.ok('POST', '/api/fields', { name: 'value', type: 'text' })
    const first = await bob.ok('POST', '/api/boards/import', { file })
    expect(first.lost).toEqual([])
    const mine = (await bob.ok('GET', '/api/fields')).fields
    // "value" was taken by a text field of his, so the number arrives beside it.
    expect(mine.map((f: { name: string; type: string }) => [f.name, f.type])).toEqual([
      ['value', 'text'],
      ['Company', 'text'],
      ['Value (2)', 'number'],
      ['Stage', 'choice'],
    ])
    const by = (name: string) => mine.find((f: { name: string }) => f.name === name)
    const board = await load(bob, first.id)
    expect(board.data.fields).toMatchObject([{ id: by('Company').id, front: true }, { id: by('Value (2)').id }, { id: by('Stage').id }])
    expect(board.data.tasks.A3.custom).toEqual({ [by('Company').id]: 'Acme', [by('Value (2)').id]: 5, [by('Stage').id]: [won] })
    // A second import uses the same fields.
    const second = await bob.ok('POST', '/api/boards/import', { file })
    expect((await bob.ok('GET', '/api/fields')).fields.map((f: { boards: number }) => f.boards)).toEqual([0, 2, 2, 2])
    expect((await load(bob, second.id)).data.tasks.A3.custom).toEqual(board.data.tasks.A3.custom)
  })
})
