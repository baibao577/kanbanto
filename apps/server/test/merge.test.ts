import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardFieldRows, tasks } from '../src/db/schema'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok('GET', `/api/boards/${id}`)
const mutate = (p: Person, id: string, command: object) => p.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const set = async (p: Person, id: string, taskId: string, custom: object) => {
  const r = await mutate(p, id, { type: 'task.update', id: taskId, fields: { custom } })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
}
const stored = async (boardId: string, taskId: string) =>
  (
    await t.db
      .select({ custom: tasks.custom })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), eq(tasks.id, taskId)))
  )[0]?.custom
type Pick = { id: string; front?: boolean; total?: boolean }
const pick = (p: Person, id: string, fields: Pick[]) => p.ok('PUT', `/api/boards/${id}/fields`, { fields })
const names = (fields: { name: string }[]) => fields.map((f) => f.name)

/** Ann's workspace Acme (Bob is a member, not an admin), where boards are made from the example and fields added. */
async function space() {
  const ann = await Person.signUp(t.app, 'Ann')
  const bob = await Person.signUp(t.app, 'Bob')
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
  const base = `/api/workspaces/${ws}/fields`
  const board = async (name: string) => (await ann.ok('POST', '/api/boards', { name, workspaceId: ws, template: 'example' })).id as string
  const field = async (body: object) => (await ann.ok('POST', base, body)).id as string
  const library = async () =>
    (await ann.ok('GET', base)).fields as { id: string; name: string; boards: number; options?: { id: string; name: string; archived?: boolean }[] }[]
  const merge = (p: Person, from: string, into: string) => p.request('POST', `${base}/${from}/merge`, { into })
  const preview = (from: string, into: string) => ann.ok('GET', `${base}/${from}/merge?into=${into}`)
  return { ann, bob, ws, base, board, field, library, merge, preview }
}

describe('merging two fields', () => {
  it('moves every value to the kept field; where a card has both, the one its board shows stays', async () => {
    const { ann, bob, board, field, library, merge, preview } = await space()
    const old = await field({ name: 'Company name', type: 'text' })
    const kept = await field({ name: 'Company', type: 'text' })
    const other = await field({ name: 'Notes', type: 'text' })
    const [both, onlyOld, keptHidden, oldHidden, neither] = [
      await board('Both'),
      await board('Only old'),
      await board('Kept hidden'),
      await board('Old hidden'),
      await board('Neither'),
    ]
    // Both shown.
    await pick(ann, both, [{ id: other }, { id: old }, { id: kept }])
    await set(ann, both, 'A3', { [old]: 'Old Co', [kept]: 'Kept Co', [other]: 'n' })
    await set(ann, both, 'A1', { [old]: 'Only old here' })
    // Only the one that goes, on the card front, with a saved filter about it.
    await pick(ann, onlyOld, [{ id: old, front: true }, { id: other }])
    await set(ann, onlyOld, 'A3', { [old]: 'Solo' })
    const settings = {
      display: { board: { columns: 'status', rows: 'none', filter: 'all', parentDisplay: ['label'] } },
      outline: { sort: { key: `f:${old}`, dir: 'asc' }, hidden: [`f:${old}`, 'due'] },
      filter: { fields: { [old]: { has: true } } },
    }
    await ann.ok('POST', `/api/boards/${onlyOld}/presets`, { name: 'With a company', settings })
    // The kept one was used here once and taken off: its value is hidden, the other's is what people see.
    await pick(ann, keptHidden, [{ id: kept }, { id: old }])
    await set(ann, keptHidden, 'A3', { [kept]: 'Stale', [old]: 'Seen' })
    await pick(ann, keptHidden, [{ id: other }, { id: old, front: true }])
    // The other way round: the one that goes is hidden here.
    await pick(ann, oldHidden, [{ id: kept }, { id: old }])
    await set(ann, oldHidden, 'A3', { [kept]: 'Seen', [old]: 'Stale' })
    await set(ann, oldHidden, 'A1', { [old]: 'Hidden, and all there is' })
    await pick(ann, oldHidden, [{ id: kept }])
    await pick(ann, neither, [{ id: other }])

    expect(await preview(old, kept)).toEqual({ cards: 6, boards: 4, both: 3, options: [], differs: [] })
    const seqs = async () =>
      Object.fromEntries(await Promise.all([both, onlyOld, keptHidden, oldHidden, neither].map(async (b) => [b, (await load(ann, b)).seq])))
    const was = await seqs()
    const snapshot = (await load(ann, both)).data.tasks.A3

    // Only the workspace's admins.
    expect((await merge(bob, old, kept)).status).toBe(403)
    const done = await merge(ann, old, kept)
    expect(done.status).toBe(200)
    expect(done.body.cards).toBe(6)
    expect(names(done.body.fields)).toEqual(['Company', 'Notes'])
    expect((await library()).find((f) => f.id === kept)!.boards).toBe(4)

    // Each board: the kept field where the other was, and its cards' values.
    const now = async (b: string) => (await load(ann, b)).data
    expect((await now(both)).fields.map((f: Pick) => f.id)).toEqual([other, kept])
    expect((await now(both)).tasks.A3.custom).toEqual({ [kept]: 'Kept Co', [other]: 'n' })
    expect((await now(both)).tasks.A1.custom).toEqual({ [kept]: 'Only old here' })
    expect((await now(onlyOld)).fields).toMatchObject([{ id: kept, front: true }, { id: other }])
    expect((await now(onlyOld)).tasks.A3.custom).toEqual({ [kept]: 'Solo' })
    expect((await now(keptHidden)).fields).toMatchObject([{ id: other }, { id: kept, front: true }])
    expect((await now(keptHidden)).tasks.A3.custom).toEqual({ [kept]: 'Seen' })
    expect((await now(oldHidden)).fields.map((f: Pick) => f.id)).toEqual([kept])
    expect((await now(oldHidden)).tasks.A3.custom).toEqual({ [kept]: 'Seen' })
    expect((await now(oldHidden)).tasks.A1.custom).toEqual({ [kept]: 'Hidden, and all there is' })
    // Nothing anywhere still names the field that went.
    for (const b of [both, onlyOld, keptHidden, oldHidden]) expect(JSON.stringify(await stored(b, 'A3'))).not.toContain(old)
    expect(await t.db.select().from(boardFieldRows).where(eq(boardFieldRows.fieldId, old))).toEqual([])
    // Exactly the boards that had either field were told.
    const is = await seqs()
    for (const b of [both, onlyOld, keptHidden, oldHidden]) expect(is[b], b).toBeGreaterThan(was[b])
    expect(is[neither]).toBe(was[neither])
    // The saved filter follows.
    const { presets } = await ann.ok('GET', `/api/boards/${onlyOld}/presets`)
    expect(presets[0].settings).toMatchObject({
      outline: { sort: { key: `f:${kept}`, dir: 'asc' }, hidden: [`f:${kept}`, 'due'] },
      filter: { fields: { [kept]: { has: true } } },
    })
    // The log says so on the boards that showed it.
    const log = async (b: string) => JSON.stringify(await ann.ok('GET', `/api/boards/${b}/activity`))
    expect(await log(onlyOld)).toContain('merged the field “Company name” into “Company”')
    expect(await log(oldHidden)).not.toContain('merged the field')

    // An undo made before the merge can't put the card back as it was: it would wipe what the merge moved.
    const current = (await load(ann, both)).data.tasks.A3
    const undo = await mutate(ann, both, {
      type: 'records.restore',
      changes: [{ entity: 'task', id: 'A3', before: current, after: { ...snapshot, version: current.version + 1 } }],
    })
    expect(undo.status).toBe(422)
    expect(undo.body.error).toBe('This board’s fields changed since, so it can’t be undone.')
    expect((await now(both)).tasks.A3.custom).toEqual({ [kept]: 'Kept Co', [other]: 'n' })
    // And one sent with the card as it was before (a tab that hasn't caught up) is refused too: the card has changed.
    expect(
      (
        await mutate(ann, both, {
          type: 'records.restore',
          changes: [{ entity: 'task', id: 'A3', before: snapshot, after: { ...snapshot, title: 'x' } }],
        })
      ).status,
    ).toBe(422)
  })

  it('says why not: another kind, an archived field, itself, a field that isn’t there', async () => {
    const { ann, base, field, merge, preview } = await space()
    const text = await field({ name: 'Company', type: 'text' })
    const number = await field({ name: 'Value', type: 'number' })
    const gone = await field({ name: 'Old', type: 'text' })
    await ann.ok('PATCH', `${base}/${gone}`, { archived: true })
    expect((await merge(ann, text, number)).body.error).toBe('“Company” is a text and “Value” a number: only fields of the same kind can be merged.')
    expect((await preview(text, number)).problem).toMatch(/same kind/)
    expect((await merge(ann, gone, text)).body.error).toMatch(/Restore the archived field first/)
    expect((await merge(ann, text, text)).body.error).toMatch(/another field/)
    expect((await merge(ann, text, '01900000-0000-7000-8000-00000000dead')).status).toBe(404)
    // Someone's own library is theirs alone.
    const mine = (await ann.ok('POST', '/api/fields', { name: 'Mine', type: 'text' })).id
    expect((await merge(ann, text, mine)).status).toBe(404)
  })

  it('a choice: options go by name, the rest are added; numbers: the kept field’s unit, and its total only if it adds up', async () => {
    const { ann, base, board, field, library, merge, preview } = await space()
    const opt = (name: string, color = 'gray') => ({ name, color })
    const phase = await field({ name: 'Phase', type: 'choice', options: [opt('lead'), opt('Closed', 'green'), opt('Parked'), opt('Dead')] })
    const stage = await field({ name: 'Stage', type: 'choice', options: [opt('Lead', 'blue'), opt('Won', 'green')] })
    const ids = async (id: string) => Object.fromEntries((await library()).find((f) => f.id === id)!.options!.map((o) => [o.name, o.id]))
    const p = await ids(phase)
    const s = await ids(stage)
    const amount = await field({ name: 'Amount', type: 'number', unit: '€', sum: true })
    const value = await field({ name: 'Value', type: 'number', unit: '$' })
    const one = await board('One')
    await pick(ann, one, [{ id: phase }, { id: stage }, { id: amount, total: true }])
    await set(ann, one, 'A1', { [phase]: [p.lead], [amount]: 5 })
    await set(ann, one, 'A2', { [phase]: [p.Closed], [stage]: [s.Won] })
    await set(ann, one, 'A3', { [phase]: [p.Parked] })
    // Parked is put away (a card still has it); Dead too, and no card has it.
    const options = (await library()).find((f) => f.id === phase)!.options!.map((o) => ({ ...o, archived: ['Parked', 'Dead'].includes(o.name) }))
    await ann.ok('PATCH', `${base}/${phase}`, { options })

    expect(await preview(phase, stage)).toEqual({ cards: 3, boards: 1, both: 1, options: ['Closed'], differs: [] })
    expect((await merge(ann, phase, stage)).status).toBe(200)
    const after = (await library()).find((f) => f.id === stage)!.options!
    expect(after.map((o) => `${o.name}${o.archived ? ' (archived)' : ''}`)).toEqual(['Lead', 'Won', 'Closed', 'Parked (archived)'])
    const now = await ids(stage)
    const { data } = await load(ann, one)
    expect(data.tasks.A1.custom).toMatchObject({ [stage]: [s.Lead] })
    expect(data.tasks.A2.custom).toEqual({ [stage]: [s.Won] })
    expect(data.tasks.A3.custom).toEqual({ [stage]: [now.Parked] })

    expect(await preview(amount, value)).toMatchObject({ cards: 1, both: 0, differs: ['unit', 'sum'] })
    expect((await merge(ann, amount, value)).status).toBe(200)
    const board1 = (await load(ann, one)).data
    expect(board1.fields.map((f: { name: string; total?: boolean }) => [f.name, !!f.total])).toEqual([
      ['Stage', false],
      ['Value', false],
    ])
    expect(board1.tasks.A1.custom[value]).toBe(5)
  })

  it('people and several cards are joined; a checkbox is ticked if either was', async () => {
    const { ann, bob, board, field, merge, preview } = await space()
    const crew = await field({ name: 'Crew', type: 'person', many: true })
    const team = await field({ name: 'Team', type: 'person', many: true })
    const ok1 = await field({ name: 'Signed', type: 'checkbox' })
    const ok2 = await field({ name: 'Contract', type: 'checkbox' })
    const one = await board('One')
    await pick(ann, one, [{ id: crew }, { id: team }, { id: ok1 }, { id: ok2 }])
    await set(ann, one, 'A1', { [crew]: [ann.user.id, bob.user.id], [team]: [bob.user.id], [ok1]: true })
    await set(ann, one, 'A2', { [ok1]: true, [ok2]: true })
    expect(await preview(crew, team)).toMatchObject({ cards: 1, both: 0 })
    await merge(ann, crew, team)
    await merge(ann, ok1, ok2)
    const { data } = await load(ann, one)
    expect(data.tasks.A1.custom).toEqual({ [team]: [bob.user.id, ann.user.id], [ok2]: true })
    expect(data.tasks.A2.custom).toEqual({ [ok2]: true })
    // Two card links only when their cards come from the same place.
    const here = await field({ name: 'Related', type: 'link', linkTo: 'same', many: true })
    const anywhere = await field({ name: 'See also', type: 'link', many: true })
    expect((await merge(ann, here, anywhere)).body.error).toMatch(/different places/)
  })

  it('a board that adds one of the two fields at the same moment ends up right either way', async () => {
    const { ann, board, field, merge } = await space()
    const old = await field({ name: 'Company name', type: 'text' })
    const kept = await field({ name: 'Company', type: 'text' })
    const one = await board('One')
    const two = await board('Two')
    await pick(ann, one, [{ id: old }])
    await set(ann, one, 'A3', { [old]: 'Acme' })
    const [merged, picked] = await Promise.all([merge(ann, old, kept), ann.request('PUT', `/api/boards/${two}/fields`, { fields: [{ id: old }] })])
    expect(merged.status).toBe(200)
    // Either the board got the field first (and now has the kept one), or it was too late (and was told).
    const fields = (await load(ann, two)).data.fields.map((f: { id: string }) => f.id)
    if (picked.status === 200) expect(fields).toEqual([kept])
    else {
      expect(picked.body.error).toMatch(/no longer available/)
      expect(fields).toEqual([])
    }
    expect(await t.db.select().from(boardFieldRows).where(eq(boardFieldRows.fieldId, old))).toEqual([])
    expect((await load(ann, one)).data.tasks.A3.custom).toEqual({ [kept]: 'Acme' })
  })
})
