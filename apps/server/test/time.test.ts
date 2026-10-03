import type { PlanningView, TimeEntryView, TimeMine, WeekView } from '@kanbanto/model/api'
import { fromDay, mondayOf, toDay } from '@kanbanto/model/dates'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const today = new Date().toISOString().slice(0, 10)

/** Ann (admin) made the workspace "Acme" and a board in it with two cards; Bob and Dan are in it; Carl isn't. */
async function acme() {
  const ann = await Person.signUp(t.app, 'Ann')
  const bob = await Person.signUp(t.app, 'Bob')
  const carl = await Person.signUp(t.app, 'Carl')
  const dan = await Person.signUp(t.app, 'Dan')
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
  await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'dan@example.com' })
  const { id: board } = await ann.ok('POST', '/api/boards', { name: 'Client A', workspaceId: ws })
  await card(ann, board, 'api', 'API integration')
  await card(ann, board, 'qa', 'Checkout bugs')
  return { ann, bob, carl, dan, ws, board }
}
const card = (p: Person, board: string, id: string, title: string) =>
  p.ok('POST', `/api/boards/${board}/mutations`, { mutationId: mid(), command: { type: 'task.create', id, parentId: null, fields: { title } } })
const log = (p: Person, board: string, task: string, body: object) => p.request('POST', `/api/boards/${board}/tasks/${task}/time`, body)
const logOk = async (p: Person, board: string, task: string, body: object) => {
  const r = await log(p, board, task, body)
  if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`)
  return r.body.entry as TimeEntryView
}
const entries = async (p: Person, board: string, task: string) =>
  (await p.ok('GET', `/api/boards/${board}/tasks/${task}/time`)) as { entries: TimeEntryView[]; canLog: boolean }

describe('time on cards', () => {
  it('editors log, everyone on the board sees it, and cards get their totals', async () => {
    const { ann, bob, carl, board } = await acme()
    const e = await logOk(bob, board, 'api', { minutes: 200, day: today, note: 'API integration' })
    expect(e).toMatchObject({ user: { name: 'Bob' }, minutes: 200, day: today, note: 'API integration', editedBy: null, canEdit: true })
    await logOk(ann, board, 'api', { minutes: 30, day: today })
    const seen = await entries(ann, board, 'api')
    expect(seen.entries.map((x) => [x.user?.name, x.minutes, x.canEdit])).toEqual([
      ['Ann', 30, true],
      ['Bob', 200, true], // Ann owns the board: she can fix Bob's
    ])
    expect((await ann.ok('GET', `/api/boards/${board}`)).counts.time).toEqual({ api: 230 })

    // Carl, added as a viewer, sees it but can't log.
    await ann.ok('POST', `/api/boards/${board}/invitations`, { email: 'carl@example.com', role: 'viewer' })
    const carlSees = await entries(carl, board, 'api')
    expect(carlSees.canLog).toBe(false)
    expect(carlSees.entries.every((x) => !x.canEdit)).toBe(true)
    expect((await log(carl, board, 'api', { minutes: 30, day: today })).status).toBe(403)
  })

  it('checks what’s logged: a real day, 1 minute to 24 hours, a card that exists', async () => {
    const { bob, board } = await acme()
    expect((await log(bob, board, 'api', { minutes: 1441, day: today })).status).toBe(400)
    expect((await log(bob, board, 'api', { minutes: 0, day: today })).status).toBe(400)
    expect((await log(bob, board, 'api', { minutes: 30, day: '2026-02-30' })).status).toBe(400)
    expect((await log(bob, board, 'gone', { minutes: 30, day: today })).status).toBe(404)
  })

  it('you fix your own; a board owner or workspace admin fixes anyone’s, and it shows who did', async () => {
    const { ann, bob, dan, ws, board } = await acme()
    const e = await logOk(bob, board, 'api', { minutes: 60, day: today })
    // Dan is a member who can edit the board, but it isn't his entry.
    expect((await dan.request('PATCH', `/api/boards/${board}/time/${e.id}`, { minutes: 90 })).status).toBe(403)
    expect((await dan.request('DELETE', `/api/boards/${board}/time/${e.id}`)).status).toBe(403)
    // Bob fixes his own: not marked.
    expect((await bob.ok('PATCH', `/api/boards/${board}/time/${e.id}`, { minutes: 75, note: 'calls' })).entry).toMatchObject({
      minutes: 75,
      note: 'calls',
      editedBy: null,
    })
    // On Bob's own board in the workspace, Ann fixes Dan's time as the workspace's admin.
    const { id: bobs } = await bob.ok('POST', '/api/boards', { name: 'Client B', workspaceId: ws })
    await card(bob, bobs, 'home', 'Homepage')
    const d = await logOk(dan, bobs, 'home', { minutes: 120, day: today })
    expect((await ann.ok('PATCH', `/api/boards/${bobs}/time/${d.id}`, { day: fromDay(toDay(today) - 1) })).entry).toMatchObject({
      editedBy: { name: 'Ann' },
      day: fromDay(toDay(today) - 1),
    })
    // Made private, Bob's board is his alone: Ann can't reach it.
    await bob.ok('PATCH', `/api/boards/${bobs}/sharing`, { visibility: 'private' })
    expect((await ann.request('PATCH', `/api/boards/${bobs}/time/${d.id}`, { minutes: 30 })).status).toBe(404)
    // Deleting takes it off the card's total.
    await bob.ok('DELETE', `/api/boards/${board}/time/${e.id}`)
    expect((await bob.ok('GET', `/api/boards/${board}`)).counts.time).toEqual({})
  })

  it('the log box knows the cards you touched that day, the ones you logged on lately, and your day so far', async () => {
    const { ann, bob, board } = await acme()
    await bob.ok('POST', `/api/boards/${board}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'qa', fields: { title: 'Checkout bugs (iOS)' } },
    })
    await ann.ok('POST', `/api/boards/${board}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.update', id: 'api', fields: { title: 'API' } },
    })
    await logOk(bob, board, 'api', { minutes: 120, day: today })
    const mine = (await bob.ok('GET', `/api/boards/${board}/time/mine?day=${today}&timeZone=UTC`)) as TimeMine
    expect(mine).toMatchObject({ day: today, touched: ['qa'], recent: ['api'], logged: 120, hoursPerDay: 8 })
    const yesterday = (await bob.ok('GET', `/api/boards/${board}/time/mine?day=${fromDay(toDay(today) - 1)}&timeZone=UTC`)) as TimeMine
    expect(yesterday).toMatchObject({ touched: [], logged: 0 })
  })

  it('my week: my time on every board, and the cards I logged on, touched or have', async () => {
    const { ann, bob, ws, board } = await acme()
    const { id: other } = await bob.ok('POST', '/api/boards', { name: 'Client B', workspaceId: ws })
    await card(bob, other, 'home', 'Homepage')
    await bob.ok('POST', `/api/boards/${other}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.create', id: 'logo', parentId: 'home', fields: { title: 'Logo', assigneeId: bob.user.id } },
    })
    await logOk(bob, board, 'api', { minutes: 120, day: today })
    await logOk(ann, board, 'qa', { minutes: 60, day: today }) // not Bob's
    const monday = fromDay(mondayOf(toDay(today)))
    const week = (await bob.ok('GET', `/api/time/week?from=${monday}&timeZone=UTC`)) as WeekView
    expect(week.entries.map((e) => [e.taskId, e.minutes])).toEqual([['api', 120]])
    const rows = week.cards.map((c) => [c.boardName, c.title, c.parent, c.canLog])
    expect(rows).toContainEqual(['Client A', 'API integration', null, true])
    expect(rows).toContainEqual(['Client B', 'Logo', 'Homepage', true]) // assigned (and touched: Bob made it)
    expect(rows).toContainEqual(['Client B', 'Homepage', null, true]) // touched
    expect(week.touched[`${other}:logo`]).toEqual([today])
    expect((await bob.request('GET', `/api/time/week?from=${fromDay(mondayOf(toDay(today)) + 1)}`)).status).toBe(400)
  })

  it('Planning counts time on a linked board’s cards that still exist; a moved card takes its time along', async () => {
    const { ann, bob, ws, board } = await acme()
    const run = (command: object) => ann.ok('POST', `/api/workspaces/${ws}/planning/mutations`, { mutationId: mid(), command })
    const project = (await run({ type: 'project.add', name: 'Client A', plannedMd: 20 })).changes[0].id
    await run({ type: 'project.update', id: project, fields: { boardId: board } })
    await logOk(bob, board, 'api', { minutes: 480, day: today })
    await logOk(bob, board, 'qa', { minutes: 60, day: today })
    const v = (await ann.ok('GET', `/api/workspaces/${ws}/planning`)) as PlanningView
    expect(v.actuals).toEqual({ [board]: { [bob.user.id]: 540 } })
    // A deleted card's time doesn't count (undo would bring both back).
    await ann.ok('POST', `/api/boards/${board}/mutations`, { mutationId: mid(), command: { type: 'task.delete', id: 'qa' } })
    expect(((await ann.ok('GET', `/api/workspaces/${ws}/planning`)) as PlanningView).actuals).toEqual({ [board]: { [bob.user.id]: 480 } })
    // Moved to another board, the card's time goes with it.
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Client B', workspaceId: ws })
    const moved = await ann.ok('POST', `/api/boards/${board}/tasks/api/move`, { boardId: other })
    const newId = moved.taskId ?? moved.id
    expect((await ann.ok('GET', `/api/boards/${other}`)).counts.time).toEqual({ [newId]: 480 })
    expect(((await ann.ok('GET', `/api/workspaces/${ws}/planning`)) as PlanningView).actuals).toEqual({})
  })
})
