import { invertPlanChanges, type PlanChange } from '@kanbanto/model/planningCommands'
import type { PlanningView } from '@kanbanto/model/api'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

/** Ann (admin) made the workspace "Acme"; Bob is in it too. Carl isn't. */
async function acme() {
  const ann = await Person.signUp(t.app, 'Ann')
  const bob = await Person.signUp(t.app, 'Bob')
  const carl = await Person.signUp(t.app, 'Carl')
  const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
  await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
  return { ann, bob, carl, ws }
}
const plan = async (p: Person, ws: string) => (await p.ok('GET', `/api/workspaces/${ws}/planning`)) as PlanningView
const send = (p: Person, ws: string, command: object, mutationId = mid()) =>
  p.request('POST', `/api/workspaces/${ws}/planning/mutations`, { mutationId, command })
const ok = async (p: Person, ws: string, command: object) => {
  const r = await send(p, ws, command)
  if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`)
  return r.body as { seq: number; changes: PlanChange[] }
}
const personOf = (v: PlanningView, name: string) => v.plan.people.find((p) => p.name === name)!

describe('planning', () => {
  it('a new workspace has a plan: the roles it starts with, and everyone in the workspace', async () => {
    const { ann, ws } = await acme()
    const v = await plan(ann, ws)
    expect(v.plan.roles.map((r) => r.name)).toEqual(['SE', 'DE', 'SA', 'BA'])
    expect(v.plan.people.map((p) => p.name).sort()).toEqual(['Ann', 'Bob'])
    expect(v).toMatchObject({ canEdit: true, plan: { projects: [], blocks: [] } })
    expect(v.memberIds).toHaveLength(2)
    expect(v.seq).toBeGreaterThan(0)
  })

  it('admins and planners change it; other members see it; nobody else does', async () => {
    const { ann, bob, carl, ws } = await acme()
    const project = { type: 'project.add', name: 'Data platform', plannedMd: 40 }
    expect(await plan(bob, ws)).toMatchObject({ canEdit: false })
    expect((await send(bob, ws, project)).status).toBe(403)
    expect((await carl.request('GET', `/api/workspaces/${ws}/planning`)).status).toBe(404)
    expect((await send(carl, ws, project)).status).toBe(404)

    const bobId = (await ann.ok('GET', `/api/workspaces/${ws}`)).members.find((m: { name: string }) => m.name === 'Bob').userId
    const members = (await ann.ok('PATCH', `/api/workspaces/${ws}/members/${bobId}`, { planner: true })).members
    expect(members.find((m: { name: string }) => m.name === 'Bob')).toMatchObject({ role: 'member', planner: true })
    expect(await plan(bob, ws)).toMatchObject({ canEdit: true })
    expect((await send(bob, ws, project)).status).toBe(200)
    // Members can't make themselves planners.
    expect((await bob.request('PATCH', `/api/workspaces/${ws}/members/${bobId}`, { planner: true })).status).toBe(403)
    await ann.ok('PATCH', `/api/workspaces/${ws}/members/${bobId}`, { planner: false })
    expect((await send(bob, ws, project)).status).toBe(403)
    expect((await ann.request('PATCH', `/api/workspaces/${ws}/members/${bobId}`, {})).status).toBe(400)
  })

  it('blocks: added, moved, split; overlaps and bad shares refused; the change counter goes up', async () => {
    const { ann, ws } = await acme()
    const v0 = await plan(ann, ws)
    const annId = personOf(v0, 'Ann').id
    await ok(ann, ws, { type: 'project.add', id: '01a10000-0000-7000-8000-000000000001', name: 'Data platform', plannedMd: 20 })
    const project = '01a10000-0000-7000-8000-000000000001'
    const block = '01a10000-0000-7000-8000-000000000002'
    const r = await ok(ann, ws, {
      type: 'block.add',
      id: block,
      projectId: project,
      personId: annId,
      start: '2026-10-05',
      end: '2026-10-30',
      pct: 50,
    })
    expect(r.changes[0]).toMatchObject({ entity: 'block', after: { start: '2026-10-05', end: '2026-10-30', pct: 50, version: 1 } })
    expect(r.seq).toBe(v0.seq + 2)

    const overlap = await send(ann, ws, { type: 'block.add', projectId: project, personId: annId, start: '2026-10-26', end: '2026-11-06', pct: 50 })
    expect(overlap).toMatchObject({ status: 422, body: { error: 'That would overlap another block of Ann on Data platform.' } })
    expect(
      (await send(ann, ws, { type: 'block.add', projectId: project, personId: annId, start: '2026-11-02', end: '2026-11-06', pct: 60 })).status,
    ).toBe(400)

    await ok(ann, ws, { type: 'block.split', id: block, at: '2026-10-19' })
    await ok(ann, ws, { type: 'block.update', id: block, fields: { personId: null } })
    const v = await plan(ann, ws)
    const byStart = [...v.plan.blocks].sort((x, y) => (x.start < y.start ? -1 : 1))
    expect(byStart.map((b) => [b.personId, b.start, b.end])).toEqual([
      [null, '2026-10-05', '2026-10-16'],
      [annId, '2026-10-19', '2026-10-30'],
    ])
    expect(v.activity[project]).toMatchObject({ by: 'Ann' })
  })

  it('undo puts things back; a retried request runs once', async () => {
    const { ann, ws } = await acme()
    const annId = personOf(await plan(ann, ws), 'Ann').id
    const { changes } = await ok(ann, ws, { type: 'project.add', name: 'Data platform' })
    const project = changes[0].id
    await ok(ann, ws, { type: 'block.add', projectId: project, personId: annId, start: '2026-10-05', end: '2026-10-09', pct: 100 })
    const before = await plan(ann, ws)
    const removed = await ok(ann, ws, { type: 'project.remove', id: project })
    expect(removed.changes.map((c) => c.entity)).toEqual(['block', 'project'])
    const after = await plan(ann, ws)
    expect([after.plan.projects.length, after.plan.blocks.length]).toEqual([0, 0])
    await ok(ann, ws, { type: 'plan.restore', changes: invertPlanChanges(after.plan, removed.changes, new Date().toISOString()) })
    const back = await plan(ann, ws)
    expect(back.plan.blocks.map((b) => b.id)).toEqual(before.plan.blocks.map((b) => b.id))
    expect(back.plan.projects.map((p) => p.name)).toEqual(['Data platform'])

    const id = mid()
    const first = await send(ann, ws, { type: 'project.add', name: 'Mobile app' }, id)
    const again = await send(ann, ws, { type: 'project.add', name: 'Mobile app' }, id)
    expect(again.body).toEqual(first.body)
    expect((await plan(ann, ws)).plan.projects).toHaveLength(2)
  })

  it('several "not assigned yet" lines on a project, each with its own time', async () => {
    const { ann, ws } = await acme()
    const project = (await ok(ann, ws, { type: 'project.add', name: 'Mobile app' })).changes[0].id
    const add = (slot: number) =>
      send(ann, ws, { type: 'block.add', projectId: project, personId: null, slot, start: '2026-10-05', end: '2026-10-09', pct: 100 })
    expect((await add(0)).status).toBe(200)
    expect((await add(1)).body.error).toMatch(/no longer there/)
    await ok(ann, ws, { type: 'project.addOpenLine', id: project })
    expect((await add(1)).status).toBe(200)
    const v = await plan(ann, ws)
    expect(v.plan.projects[0].openLines).toBe(2)
    expect(v.plan.blocks.map((b) => b.slot).sort()).toEqual([0, 1])
  })

  it('a project links to a board in the same workspace; the link goes when the board leaves it', async () => {
    const { ann, ws } = await acme()
    const project = (await ok(ann, ws, { type: 'project.add', name: 'Data platform' })).changes[0].id
    const { id: board } = await ann.ok('POST', '/api/boards', { name: 'Data platform', workspaceId: ws })
    const { id: personal } = await ann.ok('POST', '/api/boards', { name: 'Mine' })
    expect((await plan(ann, ws)).boards.map((b) => b.name)).toEqual(['Data platform'])
    expect((await send(ann, ws, { type: 'project.update', id: project, fields: { boardId: personal } })).body.error).toMatch(
      /isn’t in this workspace/,
    )
    await ok(ann, ws, { type: 'project.update', id: project, fields: { boardId: board } })
    expect((await plan(ann, ws)).plan.projects[0].boardId).toBe(board)
    const seq = (await plan(ann, ws)).seq
    await ann.ok('PUT', `/api/boards/${board}/workspace`, { workspaceId: null })
    const after = await plan(ann, ws)
    expect(after.plan.projects[0]).toMatchObject({ boardId: null, version: 3 })
    expect(after.seq).toBe(seq + 1)
  })

  it('a linked board’s Timeline gets its project’s plan, for people in the workspace only', async () => {
    const { ann, bob, carl, ws } = await acme()
    const annId = personOf(await plan(ann, ws), 'Ann').id
    const project = (await ok(ann, ws, { type: 'project.add', name: 'Data platform', plannedMd: 20 })).changes[0].id
    const { id: board } = await ann.ok('POST', '/api/boards', { name: 'Data platform', workspaceId: ws })
    expect(await ann.ok('GET', `/api/boards/${board}/plan`)).toEqual({ plan: null })
    await ok(ann, ws, { type: 'project.update', id: project, fields: { boardId: board } })
    await ok(ann, ws, { type: 'block.add', projectId: project, personId: annId, start: '2026-10-05', end: '2026-10-16', pct: 50 })
    await ok(ann, ws, { type: 'block.add', projectId: project, personId: null, start: '2026-10-05', end: '2026-10-09', pct: 100 })
    const seen = (await bob.ok('GET', `/api/boards/${board}/plan`)).plan
    expect(seen).toMatchObject({ workspaceId: ws, project: { name: 'Data platform', plannedMd: 20, prospect: false }, scheduled: 10, unassigned: 5 })
    expect(seen.lines.map((l: { name: string | null; blocks: unknown[] }) => [l.name, l.blocks.length])).toEqual([
      ['Ann', 1],
      [null, 1],
    ])
    // Marked as a prospect: saved, and the band knows.
    await ok(ann, ws, { type: 'project.update', id: project, fields: { prospect: true } })
    expect((await plan(ann, ws)).plan.projects[0]).toMatchObject({ prospect: true })
    expect((await bob.ok('GET', `/api/boards/${board}/plan`)).plan.project.prospect).toBe(true)
    // Shared with Carl, who isn't in the workspace: the board opens, its plan doesn't.
    await ann.ok('POST', `/api/boards/${board}/invitations`, { email: 'carl@example.com', role: 'viewer' })
    expect(await carl.ok('GET', `/api/boards/${board}/plan`)).toEqual({ plan: null })
  })

  it('projects and people keep the order planners put them in', async () => {
    const { ann, bob, ws } = await acme()
    const a = (await ok(ann, ws, { type: 'project.add', name: 'Alpha' })).changes[0].id
    const b = (await ok(ann, ws, { type: 'project.add', name: 'Beta' })).changes[0].id
    await ok(ann, ws, { type: 'project.move', id: b, beforeId: a })
    const view = await plan(bob, ws)
    expect(view.plan.projects.map((p: { name: string }) => p.name)).toEqual(['Beta', 'Alpha'])
    const bobId = personOf(view, 'Bob').id
    const annId = personOf(view, 'Ann').id
    await ok(ann, ws, { type: 'person.move', id: bobId, beforeId: annId })
    const people = (await plan(bob, ws)).plan.people as { id: string; position: string | null }[]
    const pos = (id: string) => people.find((p) => p.id === id)!.position!
    expect(pos(bobId) < pos(annId)).toBe(true)
  })

  it('two overlapping blocks sent at the same moment: one is saved, the other refused', async () => {
    const { ann, ws } = await acme()
    const annId = personOf(await plan(ann, ws), 'Ann').id
    const project = (await ok(ann, ws, { type: 'project.add', name: 'Data platform' })).changes[0].id
    const add = (start: string, end: string) => send(ann, ws, { type: 'block.add', projectId: project, personId: annId, start, end, pct: 100 })
    const results = await Promise.all([add('2026-10-05', '2026-10-16'), add('2026-10-12', '2026-10-23')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 422])
    expect((await plan(ann, ws)).plan.blocks).toHaveLength(1)
  })

  it('a plan only ever touches its own workspace’s records', async () => {
    const { ann, ws } = await acme()
    const { id: other } = await ann.ok('POST', '/api/workspaces', { name: 'Other' })
    const project = (await ok(ann, ws, { type: 'project.add', name: 'Data platform' })).changes[0].id
    // Another workspace can't point at it, edit it, or reuse its id.
    expect(
      (await send(ann, other, { type: 'block.add', projectId: project, personId: null, start: '2026-10-05', end: '2026-10-09', pct: 100 })).body
        .error,
    ).toMatch(/project is no longer/)
    expect((await send(ann, other, { type: 'project.update', id: project, fields: { name: 'Mine' } })).status).toBe(422)
    expect((await send(ann, other, { type: 'project.add', id: project, name: 'Copy' })).body.error).toMatch(/already in use/)
    expect((await plan(ann, ws)).plan.projects[0].name).toBe('Data platform')
  })

  it('people: members stay while they’re in the workspace; someone who leaves keeps their time and gets it back', async () => {
    const { ann, bob, ws } = await acme()
    const v = await plan(ann, ws)
    const bobPerson = personOf(v, 'Bob')
    const project = (await ok(ann, ws, { type: 'project.add', name: 'Data platform' })).changes[0].id
    await ok(ann, ws, { type: 'block.add', projectId: project, personId: bobPerson.id, start: '2026-10-05', end: '2026-10-09', pct: 50 })
    expect((await send(ann, ws, { type: 'person.remove', id: bobPerson.id })).body.error).toMatch(/stay in its plan/)
    // Named people come and go.
    const nida = (await ok(ann, ws, { type: 'person.add', name: 'Nida (contractor)', hoursPerDay: 6 })).changes[0].id
    await ok(ann, ws, { type: 'person.remove', id: nida })

    const bobId = bobPerson.userId!
    await ann.ok('DELETE', `/api/workspaces/${ws}/members/${bobId}`)
    const left = await plan(ann, ws)
    expect(left.memberIds).not.toContain(bobId)
    expect(personOf(left, 'Bob').id).toBe(bobPerson.id)
    expect(left.plan.blocks[0].personId).toBe(bobPerson.id)

    // Back in the workspace: the same person in the plan, time and all.
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const back = await plan(bob, ws)
    expect(back.plan.people.filter((p) => p.name === 'Bob')).toHaveLength(1)
    expect(back.plan.blocks[0].personId).toBe(bobPerson.id)

    // Once gone for good, their time becomes time nobody has yet.
    await ann.ok('DELETE', `/api/workspaces/${ws}/members/${bobId}`)
    await ok(ann, ws, { type: 'person.remove', id: bobPerson.id })
    expect((await plan(ann, ws)).plan.blocks[0].personId).toBeNull()
  })
})
