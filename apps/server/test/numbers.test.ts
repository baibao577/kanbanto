import { applyChanges, invertChanges } from '@kanbanto/model/changes'
import type { Change } from '@kanbanto/model/records'
import { exportFile } from '@kanbanto/model/transfer'
import type { BoardData, Task } from '@kanbanto/model/types'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { numberBoards } from '../src/boards/numbering'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

type Snapshot = { data: BoardData; seq: number }
const load = (p: Person, id: string) => p.ok<Snapshot>('GET', `/api/boards/${id}`)
const mutate = (p: Person, id: string, command: unknown, mutationId = mid()) =>
  p.request<{ seq: number; changes: Change[]; error?: string }>('POST', `/api/boards/${id}/mutations`, { mutationId, command })
const create = (p: Person, id: string, taskId: string, title = taskId, parentId: string | null = null) =>
  mutate(p, id, { type: 'task.create', id: taskId, parentId, fields: { title } })
const task = (r: { body: { changes: Change[] } }, id: string) => r.body.changes.find((c) => c.entity === 'task' && c.id === id)!.after as Task
/** The board as the database has it now (not the server's memory). */
const fresh = async (p: Person, id: string) => {
  t.app.engine.forget(id)
  return (await load(p, id)).data
}
const rows = (boardId: string) =>
  t.db.execute<{ id: string; number: number | null }>(sql`select id, number from tasks where board_id = ${boardId} order by number nulls last, id`)
const boardRow = async (id: string) =>
  (
    await t.db.execute<{ code: string | null; past_codes: string[]; next_number: number; seq: number }>(
      sql`select code, past_codes, next_number, seq::int from boards where id = ${id}`,
    )
  )[0]
const numbersOf = (data: BoardData) => Object.fromEntries(Object.values(data.tasks).map((x) => [x.id, x.number]))

describe('card numbers', () => {
  it('a new board has letters from its name, and its cards are numbered as the outline shows them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [first] = (await ann.ok('GET', '/api/boards')).boards
    expect(first.code).toBe('MY')
    const { data } = await load(ann, first.id)
    expect(data.board.code).toBe('MY')
    // The example board: Launch website and what's under it first, in outline order.
    expect(numbersOf(data)).toMatchObject({ A: 1, A1: 2, A2: 3, A2a: 4, A2b: 5, A3: 6, A4: 7, B: 8, B1: 9, B2: 10, C: 11, C1: 12, C2: 13 })
    expect((await boardRow(first.id)).next_number).toBe(14)

    const { id } = await ann.ok('POST', '/api/boards', { name: 'Website launch' })
    expect((await load(ann, id)).data.board.code).toBe('WEB')
    // The same name again, in the same space: other letters.
    const { id: again } = await ann.ok('POST', '/api/boards', { name: 'Website launch' })
    expect((await load(ann, again)).data.board.code).toBe('WL')
    // A name with no Latin letters.
    const { id: thai } = await ann.ok('POST', '/api/boards', { name: 'งานบ้าน' })
    expect((await load(ann, thai)).data.board.code).toBe('B1')
    // A starter, and the Clients board made with it.
    const made = await ann.ok('POST', '/api/boards', { name: 'Deals', template: 'sales' })
    const deals = (await load(ann, made.id)).data
    expect(deals.board.code).toBe('DEA')
    expect(
      Object.values(deals.tasks)
        .map((x) => x.number)
        .sort((a, b) => a! - b!),
    ).toEqual(Object.values(deals.tasks).map((_, i) => i + 1))
    expect((await load(ann, made.clients.id)).data.board.code).toBe('CLI')
    // The Inbox is IN, for everyone.
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    expect((await load(ann, inbox)).data.board.code).toBe('IN')
    const bob = await Person.signUp(t.app, 'Bob')
    const { boardId: bobs } = await bob.ok('POST', '/api/inbox')
    expect((await load(bob, bobs)).data.board.code).toBe('IN')
    // And the list of boards says each one's letters.
    const listed = (await ann.ok('GET', '/api/boards')).boards as { id: string; code: string }[]
    expect(Object.fromEntries(listed.map((b) => [b.id, b.code]))).toMatchObject({ [id]: 'WEB', [again]: 'WL', [inbox]: 'IN' })
  })

  it('a new card takes the next number, in the answer and in the database; subtasks too', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Plan' })
    const a = await create(ann, id, 't1')
    expect(task(a, 't1').number).toBe(1)
    const b = await create(ann, id, 't2', 'Sub', 't1')
    expect(task(b, 't2').number).toBe(2)
    expect(numbersOf(await fresh(ann, id))).toEqual({ t1: 1, t2: 2 })
    expect((await boardRow(id)).next_number).toBe(3)
    // A number sent with the command is not a card's field: it's dropped, and the server gives its own.
    const sly = await mutate(ann, id, { type: 'task.create', id: 't3', parentId: null, fields: { title: 'Sly', number: 900 } })
    expect(task(sly, 't3').number).toBe(3)
    // A retried request gives the same answer, and uses no second number.
    const once = await create(ann, id, 't4')
    const cmd = { type: 'task.create', id: 't5', parentId: null, fields: { title: 'Twice' } }
    const [x, y] = [await mutate(ann, id, cmd, 'same'), await mutate(ann, id, cmd, 'same')]
    expect([task(once, 't4').number, task(x, 't5').number, y.body]).toEqual([4, 5, x.body])
    expect((await boardRow(id)).next_number).toBe(6)
  })

  it('two people adding at the same moment get different numbers, with none skipped', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Plan' })
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => create(ann, id, `c${i}`)))
    expect(made.every((r) => r.status === 200)).toBe(true)
    expect(made.map((r, i) => task(r, `c${i}`).number).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect((await rows(id)).map((r) => r.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('every later change leaves a card’s number alone', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const before = numbersOf((await load(ann, id)).data)
    await mutate(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship it', status: 'done' } })
    await mutate(ann, id, { type: 'task.move', id: 'A3', parentId: 'B', place: { end: true } })
    await mutate(ann, id, {
      type: 'tasks.update',
      cards: Object.keys(before)
        .filter((k) => !['A', 'A2', 'B', 'C'].includes(k))
        .map((k) => ({ id: k, fields: { priority: 'high' } })),
    })
    await mutate(ann, id, { type: 'column.create', id: 'review', name: 'Review', category: 'doing' })
    await mutate(ann, id, { type: 'tasks.moveToList', ids: ['A1', 'B1'], status: 'review' })
    await mutate(ann, id, { type: 'column.delete', id: 'review', moveTo: 'doing' })
    await mutate(ann, id, { type: 'task.archive', id: 'C' })
    await mutate(ann, id, { type: 'task.restore', id: 'C' })
    expect(numbersOf(await fresh(ann, id))).toEqual(before)
    expect((await boardRow(id)).next_number).toBe(14)
  })

  it('undo and redo keep numbers: an add, an edit, a delete with subtasks', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const now = () => new Date().toISOString()
    let data = (await load(ann, id)).data
    const step = async (command: unknown) => {
      const r = await mutate(ann, id, command)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const was = data
      data = applyChanges(data, r.body.changes)
      return { changes: r.body.changes, was }
    }
    // Add (14), undo, redo: it comes back as 14.
    const add = await step({ type: 'task.create', id: 'n1', parentId: null, fields: { title: 'New' } })
    expect(data.tasks.n1.number).toBe(14)
    const undone = await step({ type: 'records.restore', changes: invertChanges(data, add.changes, now()) })
    expect(data.tasks.n1).toBeUndefined()
    await step({ type: 'records.restore', changes: invertChanges(data, undone.changes, now()) })
    expect(data.tasks.n1.number).toBe(14)
    // An edit undone from a copy that never knew the number (the undo was kept before the server answered).
    const edit = await step({ type: 'task.update', id: 'n1', fields: { title: 'Newer' } })
    const blind = edit.changes.map((c) => {
      const { number: _n, ...before } = c.before as Task
      return { ...c, before } as Change
    })
    await step({ type: 'records.restore', changes: invertChanges(data, blind, now()) })
    expect(data.tasks.n1).toMatchObject({ title: 'New', number: 14 })
    // Delete a card with its subtasks, undo: each has the number it had.
    const had = numbersOf(data)
    const del = await step({ type: 'task.delete', id: 'A2' })
    expect(data.tasks.A2a).toBeUndefined()
    await step({ type: 'records.restore', changes: invertChanges(data, del.changes, now()) })
    expect(numbersOf(data)).toEqual(had)
    expect(numbersOf(await fresh(ann, id))).toEqual(had)
    // Nothing was used twice along the way, and the next new card is 15.
    expect((await boardRow(id)).next_number).toBe(15)
  })

  it('a number is never used again, and what an undo asks for is checked', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Plan' })
    await create(ann, id, 't1')
    await create(ann, id, 't2')
    await mutate(ann, id, { type: 'task.archive', id: 't2' })
    await mutate(ann, id, { type: 'task.delete', id: 't2' })
    await mutate(ann, id, { type: 'task.delete', id: 't1' })
    expect(task(await create(ann, id, 't3'), 't3').number).toBe(3)
    // A made-up undo that brings two cards "back" with the same free number, one with a number nobody was given
    // yet, and one with a live card's number: all are saved, each with a number of its own.
    const data = (await load(ann, id)).data
    const ghost = (gid: string, number: number): Change => ({
      entity: 'task',
      id: gid,
      before: null,
      after: { ...data.tasks.t3, id: gid, title: gid, number, version: 1 },
    })
    const r = await mutate(ann, id, { type: 'records.restore', changes: [ghost('g1', 1), ghost('g2', 1), ghost('g3', 500), ghost('g4', 3)] })
    expect(r.status).toBe(200)
    expect(['g1', 'g2', 'g3', 'g4'].map((g) => task(r, g).number)).toEqual([1, 4, 5, 6])
    expect((await rows(id)).map((x) => [x.id, x.number])).toEqual([
      ['g1', 1],
      ['t3', 3],
      ['g2', 4],
      ['g3', 5],
      ['g4', 6],
    ])
    // And a card can't be made with the id of an archived one.
    await mutate(ann, id, { type: 'task.archive', id: 't3' })
    const clash = await create(ann, id, 't3', 'Again')
    expect([clash.status, clash.body.error]).toEqual([422, 'A task with that id already exists.'])
  })

  it('cards added from a spreadsheet are numbered in the order of its rows', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Plan' })
    await create(ann, id, 't1')
    const titles = Array.from({ length: 300 }, (_, i) => `Row ${i + 1}`)
    await ann.ok('POST', `/api/boards/${id}/tasks/import`, { text: ['Title', ...titles].join('\n') })
    const data = await fresh(ann, id)
    const byTitle = Object.fromEntries(Object.values(data.tasks).map((x) => [x.title, x.number]))
    expect(titles.map((x) => byTitle[x])).toEqual(titles.map((_, i) => i + 2))
    expect((await boardRow(id)).next_number).toBe(302)
  })

  it('a card moved to another board takes a number there, and its old one is on record', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id: a }] = (await ann.ok('GET', '/api/boards')).boards
    const { id: b } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    await create(ann, b, 'o1')
    // "Design" (3) with its two subtasks (4, 5) goes to Ops.
    const moved = await ann.ok<{ id: string }>('POST', `/api/boards/${a}/tasks/A2/move`, { boardId: b })
    const there = await fresh(ann, b)
    const kids = Object.values(there.tasks).filter((x) => x.parentId === moved.id)
    expect(there.tasks[moved.id].number).toBe(2)
    expect(kids.map((x) => x.number).sort()).toEqual([3, 4])
    expect((await boardRow(b)).next_number).toBe(5)
    // What everyone with Ops open was sent has the numbers too (not only the database).
    expect((await load(ann, b)).data.tasks[moved.id].number).toBe(2)
    // Its old numbers stay unused on the board it left.
    expect(Object.values((await fresh(ann, a)).tasks).some((x) => [3, 4, 5].includes(x.number!))).toBe(false)
    expect(task(await create(ann, a, 'n1'), 'n1').number).toBe(14)
    const went = await t.db.execute<{ from_task_id: string; from_number: number; to_board_id: string; to_task_id: string }>(
      sql`select from_task_id, from_number, to_board_id, to_task_id from task_moves where from_board_id = ${a} order by from_number`,
    )
    expect(went.map((m) => [m.from_task_id, m.from_number, m.to_board_id])).toEqual([
      ['A2', 3, b],
      ['A2a', 4, b],
      ['A2b', 5, b],
    ])
    expect(went[0].to_task_id).toBe(moved.id)
    // Back again: a new number here, and what led to it on Ops now leads back.
    const back = await ann.ok<{ id: string }>('POST', `/api/boards/${b}/tasks/${moved.id}/move`, { boardId: a })
    expect((await fresh(ann, a)).tasks[back.id].number).toBe(15)
    const again = await t.db.execute<{ from_board_id: string; from_task_id: string; to_board_id: string; to_task_id: string }>(
      sql`select from_board_id, from_task_id, to_board_id, to_task_id from task_moves where from_task_id in ('A2', ${moved.id}) order by from_board_id = ${a} desc`,
    )
    expect(again.map((m) => [m.from_board_id, m.from_task_id, m.to_board_id, m.to_task_id])).toEqual([
      [a, 'A2', a, back.id],
      [b, moved.id, a, back.id],
    ])
    // A card filed from the Inbox is a move like any other.
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    await create(ann, inbox, 'i1', 'Call the bank')
    expect((await load(ann, inbox)).data.tasks.i1.number).toBe(1)
    const filed = await ann.ok<{ id: string }>('POST', `/api/boards/${inbox}/tasks/i1/move`, { boardId: b })
    expect((await fresh(ann, b)).tasks[filed.id].number).toBe(5)
  })

  it('an exported board comes back with its numbers, and other letters when its own are taken', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    await mutate(ann, id, { type: 'task.delete', id: 'B2' })
    await mutate(ann, id, { type: 'task.archive', id: 'C' })
    const whole = (await ann.ok<Snapshot>('GET', `/api/boards/${id}?archived=all`)).data
    const made = await ann.ok<{ id: string }>('POST', '/api/boards/import', { file: exportFile(whole) })
    const copy = (await ann.ok<Snapshot>('GET', `/api/boards/${made.id}?archived=all`)).data
    expect(copy.board.code).toBe('MFB')
    expect(numbersOf(copy)).toEqual(numbersOf(whole))
    expect(Object.fromEntries(Object.values(copy.archived!).map((x) => [x.id, x.number]))).toEqual({ C: 11, C1: 12, C2: 13 })
    // The gap a deleted card left stays a gap, and the next card goes after the highest.
    expect((await boardRow(made.id)).next_number).toBe(14)
    // Someone else, whose boards have no MY: the letters come along.
    const bob = await Person.signUp(t.app, 'Bob')
    await t.db.execute(sql`update boards set code = 'BOB' where id in (select board_id from board_members where user_id = ${bob.user.id})`)
    const theirs = await bob.ok<{ id: string }>('POST', '/api/boards/import', { file: exportFile(whole) })
    expect((await load(bob, theirs.id)).data.board.code).toBe('MY')
  })
})

describe('a board’s letters', () => {
  it('are changed by its owners only, and the old ones are remembered', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Website launch' })
    const { link } = await ann.ok('PUT', `/api/boards/${id}/invites/link`, { role: 'editor' })
    await bob.ok('POST', '/api/join', { invite: link.token })
    expect((await bob.request('PUT', `/api/boards/${id}/code`, { code: 'SITE' })).status).toBe(403)
    const before = await boardRow(id)
    expect(await ann.ok('PUT', `/api/boards/${id}/code`, { code: ' site ' })).toEqual({ code: 'SITE', pastCodes: ['WEB'] })
    // Everyone's copy is read again: the board's change counter moved, and the board says its new letters.
    expect((await boardRow(id)).seq).toBeGreaterThan(before.seq)
    expect((await load(bob, id)).data.board).toMatchObject({ code: 'SITE', pastCodes: ['WEB'] })
    expect((await bob.ok('GET', '/api/boards')).boards.find((b: { id: string }) => b.id === id)).toMatchObject({ code: 'SITE', pastCodes: ['WEB'] })
    // The same again changes nothing; its own old letters can be taken back.
    expect(await ann.ok('PUT', `/api/boards/${id}/code`, { code: 'SITE' })).toEqual({ code: 'SITE', pastCodes: ['WEB'] })
    expect(await ann.ok('PUT', `/api/boards/${id}/code`, { code: 'WEB' })).toEqual({ code: 'WEB', pastCodes: ['SITE'] })
    for (const bad of ['W', 'TOOLONG', '1AB', 'W-B', ''])
      expect((await ann.request('PUT', `/api/boards/${id}/code`, { code: bad })).status, bad).toBe(400)
  })

  it('can’t be another board’s in the same space, now or before; the Inbox keeps IN', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id: web } = await ann.ok('POST', '/api/boards', { name: 'Website launch' })
    const { id: ops } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    const taken = await ann.request('PUT', `/api/boards/${ops}/code`, { code: 'WEB' })
    expect([taken.status, taken.body.error]).toEqual([409, 'Another board here uses WEB. Choose other letters.'])
    await ann.ok('PUT', `/api/boards/${web}/code`, { code: 'SITE' })
    // (WEB was Website launch's: a WEB-12 written somewhere still means its card.)
    expect((await ann.request('PUT', `/api/boards/${ops}/code`, { code: 'WEB' })).status).toBe(409)
    expect((await ann.request('PUT', `/api/boards/${ops}/code`, { code: 'IN' })).body.error).toBe('IN is the Inbox’s. Choose other letters.')
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    expect((await ann.request('PUT', `/api/boards/${inbox}/code`, { code: 'BOX' })).status).toBe(400)
    // Someone else's own boards are another space: they can have WEB.
    const bob = await Person.signUp(t.app, 'Bob')
    const { id: bobs } = await bob.ok('POST', '/api/boards', { name: 'Website launch' })
    expect((await load(bob, bobs)).data.board.code).toBe('WEB')
    // In a workspace the database itself keeps them apart.
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    const { id: one } = await ann.ok('POST', '/api/boards', { name: 'Launch', workspaceId: ws })
    const { id: two } = await ann.ok('POST', '/api/boards', { name: 'Launch', workspaceId: ws })
    expect([(await load(ann, one)).data.board.code, (await load(ann, two)).data.board.code]).toEqual(['LAU', 'LAUN'])
    await expect(t.db.execute(sql`update boards set code = 'LAU' where id = ${two}`)).rejects.toThrow()
  })

  it('no command or undo changes them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Website launch' })
    const start = (await load(ann, id)).data
    const renamed = await mutate(ann, id, { type: 'board.update', fields: { name: 'Site', code: 'SLY' } })
    expect(renamed.body.changes[0].after).toMatchObject({ name: 'Site', code: 'WEB' })
    // An undo of that rename, kept by a copy from before boards had letters: the name goes back, the letters stay.
    const { code: _c, ...old } = start.board
    const undo = await mutate(ann, id, {
      type: 'records.restore',
      changes: [{ entity: 'board', id, before: renamed.body.changes[0].after, after: old }],
    })
    expect(undo.status).toBe(200)
    expect((await fresh(ann, id)).board).toMatchObject({ name: 'Website launch', code: 'WEB' })
    expect((await boardRow(id)).code).toBe('WEB')
  })

  it('a board moved to a space where its letters are taken gets new ones, and remembers the old', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    const { id: theirs } = await ann.ok('POST', '/api/boards', { name: 'Website launch', workspaceId: ws })
    const { id: mine } = await ann.ok('POST', '/api/boards', { name: 'Website launch' })
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    expect([(await load(ann, theirs)).data.board.code, (await load(ann, mine)).data.board.code]).toEqual(['WEB', 'WEB'])
    await ann.ok('PUT', `/api/boards/${mine}/workspace`, { workspaceId: ws })
    expect((await load(ann, mine)).data.board).toMatchObject({ code: 'WL', pastCodes: ['WEB'] })
    // One whose letters are free there keeps them.
    await ann.ok('PUT', `/api/boards/${other}/workspace`, { workspaceId: ws })
    expect((await load(ann, other)).data.board.code).toBe('OPS')
    expect((await load(ann, other)).data.board.pastCodes).toBeUndefined()
  })
})

describe('boards from before card numbers', () => {
  /** As the database was before: no letters, no numbers, the counters at 1. */
  const forget = () => t.db.execute(sql`update tasks set number = null; update boards set code = null, past_codes = '{}', next_number = 1`)

  it('get their letters and numbers when the server starts: cards in the order they were made, then as the outline shows them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id: first }] = (await ann.ok('GET', '/api/boards')).boards
    const { id: plan } = await ann.ok('POST', '/api/boards', { name: 'Plan' })
    await create(ann, plan, 'later')
    await create(ann, plan, 'earlier')
    await mutate(ann, plan, { type: 'task.archive', id: 'later' })
    const { boardId: inbox } = await ann.ok('POST', '/api/inbox')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    const { id: w1 } = await ann.ok('POST', '/api/boards', { name: 'Launch', workspaceId: ws })
    const { id: w2 } = await ann.ok('POST', '/api/boards', { name: 'Launch', workspaceId: ws })
    await forget()
    await t.db.execute(sql`update tasks set created_at = '2020-01-01' where board_id = ${plan} and id = 'earlier'`)
    const seqs = { first: (await boardRow(first)).seq, plan: (await boardRow(plan)).seq }

    expect(await numberBoards(t.db)).toEqual({ boards: 5, cards: 15 })
    expect(numbersOf(await fresh(ann, first))).toMatchObject({
      A: 1,
      A1: 2,
      A2: 3,
      A2a: 4,
      A2b: 5,
      A3: 6,
      A4: 7,
      B: 8,
      B1: 9,
      B2: 10,
      C: 11,
      C1: 12,
      C2: 13,
    })
    expect((await rows(plan)).map((r) => [r.id, r.number])).toEqual([
      ['earlier', 1],
      ['later', 2],
    ])
    expect([await boardRow(first), await boardRow(plan), await boardRow(inbox)].map((b) => [b.code, b.next_number])).toEqual([
      ['MY', 14],
      ['PLAN', 3],
      ['IN', 1],
    ])
    expect(new Set([(await boardRow(w1)).code, (await boardRow(w2)).code])).toEqual(new Set(['LAU', 'LAUN']))
    // Open copies read the boards again.
    expect((await boardRow(first)).seq).toBe(seqs.first + 1)
    expect((await boardRow(plan)).seq).toBe(seqs.plan + 1)
    // Run again (every start does): nothing left to do, nothing touched.
    expect(await numberBoards(t.db)).toEqual({ boards: 0, cards: 0 })
    expect((await boardRow(first)).seq).toBe(seqs.first + 1)
    // Two servers starting at once: each card still has one number.
    await forget()
    await Promise.all([numberBoards(t.db), numberBoards(t.db)])
    expect((await rows(first)).map((r) => r.number)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1))
    // And a card made after takes the next.
    expect(task(await create(ann, first, 'n1'), 'n1').number).toBe(14)
  })

  it('a card without a number takes one the first time it changes, and keeps the ones the others have', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    await t.db.execute(sql`update tasks set number = null where board_id = ${id} and id = 'A3'`)
    t.app.engine.forget(id)
    const r = await mutate(ann, id, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    expect(task(r, 'A3').number).toBe(14)
    expect((await rows(id)).find((x) => x.id === 'A3')!.number).toBe(14)
  })

  it('a board that slipped past start-up is numbered by the first change made to it', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    await forget()
    t.app.engine.forget(id)
    const r = await create(ann, id, 'n1')
    expect(task(r, 'n1').number).toBe(14)
    const data = await fresh(ann, id)
    expect(data.board.code).toBe('MY')
    expect(numbersOf(data)).toMatchObject({ A: 1, C2: 13, n1: 14 })
  })
})

describe('what says a card’s name', () => {
  it('Search cards finds a card by it, and each row carries it', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const found = await ann.ok('GET', `/api/cards?state=active&q=my-6`)
    expect(found.cards.map((c: { id: string; ref: string }) => [c.id, c.ref])).toEqual([['A3', 'MY-6']])
    // A card that mentions it is found too.
    await mutate(ann, id, { type: 'task.update', id: 'B1', fields: { description: 'After MY-6 is out.' } })
    const both = await ann.ok('GET', `/api/cards?state=active&q=MY-6`)
    expect(both.cards.map((c: { id: string }) => c.id).sort()).toEqual(['A3', 'B1'])
  })

  it('Search cards can look at names and titles alone, for a list that answers while someone types', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    await mutate(ann, id, { type: 'task.update', id: 'A2a', fields: { title: 'Wireframes for the footer' } })
    await mutate(ann, id, { type: 'task.update', id: 'B1', fields: { description: 'After MY-6 is out, about the wireframes.' } })
    await ann.ok('POST', `/api/boards/${id}/tasks/B2/comments`, { body: 'wireframes again' })
    const ids = async (q: string) => (await ann.ok('GET', `/api/cards?state=active&${q}`)).cards.map((c: { id: string }) => c.id).sort()
    expect(await ids('q=wireframes')).toEqual(['A2a', 'B1', 'B2'])
    expect(await ids('q=wireframes&in=titles')).toEqual(['A2a'])
    expect(await ids('q=my-6')).toEqual(['A3', 'B1'])
    expect(await ids('q=my-6&in=titles')).toEqual(['A3'])
    expect((await ann.request('GET', '/api/cards?state=active&in=comments&q=x')).status).toBe(400)
  })

  it('adding a card in one call answers with its name, and its subtasks’', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    const { card } = await ann.ok('POST', `/api/boards/${id}/cards`, { title: 'Call the printer', subtasks: [{ title: 'Ask for a quote' }] })
    expect([card.ref, card.subtasks[0].ref]).toEqual(['MY-14', 'MY-15'])
  })
})

describe('where a card is now', () => {
  type At = { boardId: string; taskId: string; moved: boolean; board?: string; ref?: string; archived?: boolean }
  const whereis = (p: Person, board: string, q: string) =>
    p.request<At & { error?: string; code?: string }>('GET', `/api/boards/${board}/whereis?${q}`)

  it('on its board: by its number, also when it’s archived', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
    expect((await whereis(ann, id, 'n=6')).body).toEqual({ boardId: id, taskId: 'A3', moved: false })
    expect((await whereis(ann, id, 'task=A3')).body).toEqual({ boardId: id, taskId: 'A3', moved: false })
    await mutate(ann, id, { type: 'task.archive', id: 'A3' })
    expect((await whereis(ann, id, 'n=6')).body).toEqual({ boardId: id, taskId: 'A3', moved: false, archived: true })
    // A number nothing has, a card that was deleted, and a question that isn't one.
    const b2 = (await load(ann, id)).data.tasks.B2.number
    await mutate(ann, id, { type: 'task.delete', id: 'B2' })
    for (const q of ['n=999', `n=${b2}`, 'task=B2', 'task=nothing']) {
      const r = await whereis(ann, id, q)
      expect([q, r.status, r.body.code]).toEqual([q, 404, undefined])
    }
    for (const q of ['', 'n=6&task=A3', 'n=0', 'n=abc', 'n=1.5', 'n=1000000000']) expect([q, (await whereis(ann, id, q)).status]).toEqual([q, 400])
  })

  it('a card moved to another board is found from its old number and its old address, subtasks too', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id: a }] = (await ann.ok('GET', '/api/boards')).boards
    const { id: b } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    const moved = await ann.ok<{ id: string }>('POST', `/api/boards/${a}/tasks/A2/move`, { boardId: b })
    const there = { boardId: b, taskId: moved.id, moved: true, board: 'Ops', ref: 'OPS-1' }
    expect((await whereis(ann, a, 'n=3')).body).toEqual(there)
    expect((await whereis(ann, a, 'task=A2')).body).toEqual(there)
    const kid = Object.values((await fresh(ann, b)).tasks).find((x) => x.parentId === moved.id && x.number === 2)!
    expect((await whereis(ann, a, 'n=4')).body).toEqual({ ...there, taskId: kid.id, ref: 'OPS-2' })
    // Where it is now, its own number answers as any card's does.
    expect((await whereis(ann, b, 'n=1')).body).toEqual({ boardId: b, taskId: moved.id, moved: false })
    // Archived there: still found, and said to be.
    await mutate(ann, b, { type: 'task.archive', id: moved.id })
    expect((await whereis(ann, a, 'n=3')).body).toEqual({ ...there, archived: true })
  })

  it('a card moved twice is found from every board it was on, and one moved back is on its board again', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const [{ id: a }] = (await ann.ok('GET', '/api/boards')).boards
    const { id: b } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    const { id: c } = await ann.ok('POST', '/api/boards', { name: 'Shop' })
    const onB = await ann.ok<{ id: string }>('POST', `/api/boards/${a}/tasks/A3/move`, { boardId: b })
    const onC = await ann.ok<{ id: string }>('POST', `/api/boards/${b}/tasks/${onB.id}/move`, { boardId: c })
    const there = { boardId: c, taskId: onC.id, moved: true, board: 'Shop', ref: 'SHOP-1' }
    expect((await whereis(ann, a, 'n=6')).body).toEqual(there)
    expect((await whereis(ann, a, 'task=A3')).body).toEqual(there)
    expect((await whereis(ann, b, 'n=1')).body).toEqual(there)
    expect((await whereis(ann, b, `task=${onB.id}`)).body).toEqual(there)
    // Back to where it started: a new card there (number 14), which its first number and address lead to.
    const back = await ann.ok<{ id: string }>('POST', `/api/boards/${c}/tasks/${onC.id}/move`, { boardId: a })
    const home = { boardId: a, taskId: back.id, moved: false, board: 'My first board', ref: 'MY-14' }
    expect((await whereis(ann, a, 'n=6')).body).toEqual(home)
    expect((await whereis(ann, a, 'task=A3')).body).toEqual(home)
    expect((await whereis(ann, a, 'n=14')).body).toEqual({ boardId: a, taskId: back.id, moved: false })
    expect((await whereis(ann, b, 'n=1')).body).toEqual({ ...home, moved: true })
    expect((await whereis(ann, c, 'n=1')).body).toEqual({ ...home, moved: true })
  })

  it('says nothing about a board the asker can’t open, nor follows a card that is gone', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const [{ id: a }] = (await ann.ok('GET', '/api/boards')).boards
    const { id: b } = await ann.ok('POST', '/api/boards', { name: 'Ops' })
    const { link } = await ann.ok('PUT', `/api/boards/${a}/invites/link`, { role: 'viewer' })
    await bob.ok('POST', '/api/join', { invite: link.token })
    const moved = await ann.ok<{ id: string }>('POST', `/api/boards/${a}/tasks/A3/move`, { boardId: b })
    // Bob is on the board it left, not the one it went to.
    const closed = await whereis(bob, a, 'n=6')
    expect([closed.status, closed.body.code]).toEqual([404, 'moved'])
    expect(JSON.stringify(closed.body)).not.toMatch(/Ops|OPS/)
    expect(JSON.stringify(closed.body)).not.toContain(moved.id)
    // A stranger isn't told the board exists; someone signed out is asked to sign in.
    const carl = await Person.signUp(t.app, 'Carl')
    expect((await whereis(carl, a, 'n=6')).status).toBe(404)
    expect((await whereis(carl, a, 'n=6')).body.code).toBeUndefined()
    expect((await whereis(new Person(t.app), a, 'n=6')).status).toBe(401)
    // With the public link on, a visitor is told what is on this board, and no more than Bob about the other.
    await ann.ok('PATCH', `/api/boards/${a}/sharing`, { publicLink: true })
    const visitor = new Person(t.app)
    expect((await whereis(visitor, a, 'n=1')).body).toMatchObject({ boardId: a, moved: false })
    expect((await whereis(visitor, a, 'n=6')).body.code).toBe('moved')
    // Once Bob can open Ops, he's led there.
    const ops = await ann.ok('PUT', `/api/boards/${b}/invites/link`, { role: 'viewer' })
    await bob.ok('POST', '/api/join', { invite: ops.link.token })
    expect((await whereis(bob, a, 'n=6')).body).toMatchObject({ boardId: b, taskId: moved.id, moved: true, ref: 'OPS-1' })
    // Deleted where it went: the trail ends, and it's said.
    await mutate(ann, b, { type: 'task.delete', id: moved.id })
    const gone = await whereis(ann, a, 'n=6')
    expect([gone.status, gone.body.code]).toEqual([404, 'moved'])
  })
})
