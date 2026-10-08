import { fromTemplate, TEMPLATES_MAX, type BoardTemplate, type CardTemplate } from '@kanbanto/model/templates'
import type { BoardData } from '@kanbanto/model/types'
import type { WebSocket } from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { boardActivity } from '../src/db/schema'
import type { LiveMessage } from '../src/live'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

type Snapshot = { data: BoardData; seq: number }
const load = (p: Person, id: string) => p.ok<Snapshot>('GET', `/api/boards/${id}`)
const run = (p: Person, id: string, command: object) => p.request('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command })
const templatesOf = async (p: Person, id: string) => (await p.ok<{ templates: CardTemplate[] }>('GET', `/api/boards/${id}/templates`)).templates
const save = (p: Person, id: string, body: object) =>
  p.request<{ template: CardTemplate; error?: string }>('POST', `/api/boards/${id}/templates`, body)
const boardTemplates = async (p: Person, workspace?: string) =>
  (await p.ok<{ templates: BoardTemplate[] }>('GET', `/api/board-templates${workspace ? `?workspace=${workspace}` : ''}`)).templates
const saveBoard = (p: Person, id: string, body: object = {}) =>
  p.request<{ template: BoardTemplate; error?: string }>('POST', `/api/boards/${id}/template`, body)
const logged = async () => (await t.db.select().from(boardActivity)).flatMap((r) => (r.items as { text: string }[]).map((i) => i.text))

/** Ann owns the example board; Bob can edit it and Vic can only look. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const [{ id }] = (await ann.ok('GET', '/api/boards')).boards
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}

describe('a board’s card templates', () => {
  it('are saved from a card by the people who can edit, and read by everyone on the board', async () => {
    const { ann, bob, vic, id } = await team()
    expect(await templatesOf(vic, id)).toEqual([])
    const messages: LiveMessage[] = []
    const ws: WebSocket = await t.app.injectWS(`/api/boards/${id}/live`, { headers: { cookie: ann.cookie! } })
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
    // Launch website (A) with everything under it; the name starts as the card's title.
    const made = await save(bob, id, { taskId: 'A' })
    expect(made.status).toBe(200)
    expect(made.body.template).toMatchObject({ name: 'Launch website', by: 'Bob' })
    expect(made.body.template.cards.map((c) => [c.parent, c.title])).toEqual([
      [null, 'Launch website'],
      ['c0', 'Buy domain'],
      ['c0', 'Design'],
      ['c2', 'Homepage'],
      ['c2', 'Logo'],
      ['c0', 'Deploy'],
      ['c0', 'Write the launch blog post'],
    ])
    // Nobody and no dates, though the cards have both.
    expect(JSON.stringify(made.body.template.cards)).not.toMatch(/assignee|due|start|"status"/)
    for (const p of [ann, bob, vic]) expect((await templatesOf(p, id)).map((x) => x.name)).toEqual(['Launch website'])
    for (let i = 0; i < 100 && !messages.some((m) => m.type === 'templates'); i++) await new Promise((r) => setTimeout(r, 20))
    ws.close()
    expect(messages.some((m) => m.type === 'templates')).toBe(true)
    // With a name of its own; a viewer can't save, a stranger sees nothing, a card that isn't there isn't one.
    expect((await save(ann, id, { taskId: 'B1', name: '  Send the invites  ' })).body.template.name).toBe('Send the invites')
    expect((await save(vic, id, { taskId: 'B1' })).status).toBe(403)
    expect((await save(ann, id, { taskId: 'nope' })).status).toBe(404)
    expect((await save(ann, id, { taskId: 'B1', name: '   ' })).status).toBe(400)
    const sam = await Person.signUp(t.app, 'Sam')
    expect((await sam.request('GET', `/api/boards/${id}/templates`)).status).toBe(404)
    expect(await logged()).toEqual(
      expect.arrayContaining(['saved “Launch website” as the template “Launch website”', 'saved “Send invites” as the template “Send the invites”']),
    )
  })

  it('are copies: changed by saving over them, renamed and removed, and untouched by what happens to the card', async () => {
    const { ann, bob, vic, id } = await team()
    const { template } = (await save(ann, id, { taskId: 'B', name: 'An event' })).body
    expect(template.cards.map((c) => c.title)).toEqual(['Event', 'Send invites', 'Book a photographer'])
    // The card goes on changing: the template stays as it was saved.
    await run(ann, id, { type: 'task.update', id: 'B1', fields: { title: 'Send the invitations' } })
    await run(ann, id, { type: 'task.delete', id: 'B2' })
    expect((await templatesOf(ann, id))[0].cards.map((c) => c.title)).toEqual(['Event', 'Send invites', 'Book a photographer'])
    // Saved over: its cards are the card's as it is now, under the same name and id.
    const over = await save(bob, id, { taskId: 'B', replace: template.id })
    expect(over.body.template).toMatchObject({ id: template.id, name: 'An event', by: 'Bob' })
    expect(over.body.template.cards.map((c) => c.title)).toEqual(['Event', 'Send the invitations'])
    expect(await templatesOf(ann, id)).toHaveLength(1)
    // Renamed and removed by the people who can edit; not by a viewer, and not through another board.
    expect((await vic.request('PATCH', `/api/boards/${id}/templates/${template.id}`, { name: 'x' })).status).toBe(403)
    await bob.ok('PATCH', `/api/boards/${id}/templates/${template.id}`, { name: 'A party' })
    expect((await templatesOf(vic, id))[0].name).toBe('A party')
    const { id: other } = await ann.ok('POST', '/api/boards', { name: 'Ops', template: 'example' })
    expect((await ann.request('DELETE', `/api/boards/${other}/templates/${template.id}`)).status).toBe(404)
    expect((await save(ann, other, { taskId: 'B', replace: template.id })).status).toBe(404)
    expect((await vic.request('DELETE', `/api/boards/${id}/templates/${template.id}`)).status).toBe(403)
    await bob.ok('DELETE', `/api/boards/${id}/templates/${template.id}`)
    expect(await templatesOf(ann, id)).toEqual([])
    // Thirty to a board.
    for (let i = 0; i < TEMPLATES_MAX; i++) expect((await save(ann, id, { taskId: 'B1', name: `T${i}` })).status).toBe(200)
    const full = await save(ann, id, { taskId: 'B1', name: 'One more' })
    expect([full.status, full.body.error]).toEqual([
      422,
      `A board can have up to ${TEMPLATES_MAX} card templates. Remove one first, or save over one.`,
    ])
  })

  it('start a card with its steps as one change: nobody assigned, no dates, and the log says where it came from', async () => {
    const { ann, bob, id } = await team()
    const { template } = (await save(ann, id, { taskId: 'A', name: 'A launch' })).body
    const { data } = await load(bob, id)
    let n = 0
    const made = fromTemplate(data, template, { status: 'doing' }, () => `t${++n}`)
    expect((await run(bob, id, made.command)).status).toBe(200)
    const after = (await load(ann, id)).data
    const top = after.tasks[made.id]
    expect(top).toMatchObject({ title: 'Launch website', status: 'doing', parentId: null })
    const added = Object.values(after.tasks).filter((x) => x.id.startsWith('t'))
    expect(added).toHaveLength(7)
    for (const x of added) expect([x.assigneeId, x.due, x.start]).toEqual([undefined, undefined, undefined])
    // Every new card has a number of its own.
    expect(new Set(added.map((x) => x.number)).size).toBe(7)
    expect(await logged()).toContain('added “Launch website” from the template “A launch”, with 6 subtasks')
    // Undone as one change.
    const { invertChanges } = await import('@kanbanto/model/changes')
    const done = await bob.ok<{ changes: Parameters<typeof invertChanges>[1] }>('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: fromTemplate(after, template, { status: 'todo' }, () => `u${++n}`).command,
    })
    const now = (await load(bob, id)).data
    await run(bob, id, { type: 'records.restore', changes: invertChanges(now, done.changes, new Date().toISOString()) })
    expect(Object.keys((await load(ann, id)).data.tasks).filter((k) => k.startsWith('u'))).toEqual([])
  })
})

describe('board templates', () => {
  it('keep a board’s shape and its card templates, never its cards or people, and make a new board', async () => {
    const { ann, bob, id } = await team()
    // A field, a limit, a rule about a person and one that isn't, a label, a card template.
    const hours = (await ann.ok('POST', '/api/fields', { name: 'Hours', type: 'number', unit: 'h', decimals: 0, sum: true })).id as string
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: hours, front: true }] })
    await run(ann, id, { type: 'task.update', id: 'B1', fields: { custom: { [hours]: 3 } } })
    const rule = (r: object) => ann.ok('POST', `/api/boards/${id}/rules`, { rule: r })
    await rule({
      kind: 'limit',
      cards: { statuses: ['doing'] },
      counts: 'leaves',
      measure: { by: 'field', field: hours },
      max: 40,
      then: [{ do: 'show' }],
    })
    await rule({ kind: 'when', on: 'enters', cards: { statuses: ['done'] }, counts: 'leaves', then: [{ do: 'tell', who: ['@assignee'] }] })
    await rule({ kind: 'when', on: 'enters', cards: { statuses: ['doing'] }, counts: 'leaves', then: [{ do: 'tell', who: [bob.user.id] }] })
    await save(ann, id, { taskId: 'B', name: 'An event' })
    await ann.ok('POST', `/api/boards/${id}/mutations`, {
      mutationId: mid(),
      command: { type: 'board.update', fields: { description: 'How we launch' } },
    })

    // Its owners save it; an editor can't. It is Ann's own: nobody else sees it.
    expect((await saveBoard(bob, id)).status).toBe(403)
    const saved = await saveBoard(ann, id, { name: 'A launch board' })
    expect(saved.status).toBe(200)
    expect(saved.body.template).toMatchObject({
      name: 'A launch board',
      workspaceId: null,
      lists: 4,
      fields: 1,
      cardTemplates: 1,
      by: 'Ann',
      canChange: true,
    })
    expect((await boardTemplates(ann)).map((x) => x.name)).toEqual(['A launch board'])
    expect(await boardTemplates(bob)).toEqual([])
    expect((await bob.request('POST', '/api/boards', { name: 'Mine', templateId: saved.body.template.id })).status).toBe(404)

    const made = await ann.ok<{ id: string; added: string[] }>('POST', '/api/boards', { name: 'Spring launch', templateId: saved.body.template.id })
    const copy = (await load(ann, made.id)).data
    const first = (await load(ann, id)).data
    expect(copy.board).toMatchObject({ name: 'Spring launch', mode: first.board.mode, description: 'How we launch' })
    expect(copy.columns.map((c) => [c.id, c.name, c.category])).toEqual(first.columns.map((c) => [c.id, c.name, c.category]))
    expect(copy.labels.map((l) => l.name)).toEqual(first.labels.map((l) => l.name))
    // The same field of her library, shown the same way; no cards; she is its only person.
    expect(copy.fields.map((f) => [f.id, f.name, f.front])).toEqual([[hours, 'Hours', true]])
    expect(made.added).toEqual([])
    expect(Object.keys(copy.tasks)).toEqual([])
    expect(copy.members.map((m) => m.name)).toEqual(['Ann'])
    // Its rules come under new ids, without the one that names a person.
    expect(copy.rules!.map((r) => r.kind)).toEqual(['limit', 'when'])
    expect(copy.rules![0]).toMatchObject({ measure: { by: 'field', field: hours }, max: 40 })
    expect(first.rules!.map((r) => r.id)).not.toContain(copy.rules![0].id)
    // Its card templates come as copies, with their values.
    const brought = await templatesOf(ann, made.id)
    expect(brought.map((x) => [x.name, x.cards.map((c) => c.title)])).toEqual([['An event', ['Event', 'Send invites', 'Book a photographer']]])
    expect(brought[0].cards[1].custom).toEqual({ [hours]: 3 })
    expect(brought[0].id).not.toBe((await templatesOf(ann, id))[0].id)

    // Saved over, renamed, removed: by its owner.
    await run(ann, id, { type: 'column.create', id: 'review', name: 'Review', category: 'doing' })
    const over = await saveBoard(ann, id, { replace: saved.body.template.id })
    expect(over.body.template).toMatchObject({ id: saved.body.template.id, name: 'A launch board', lists: 5 })
    expect((await bob.request('PATCH', `/api/board-templates/${saved.body.template.id}`, { name: 'x' })).status).toBe(404)
    await ann.ok('PATCH', `/api/board-templates/${saved.body.template.id}`, { name: 'Launches' })
    expect((await boardTemplates(ann))[0].name).toBe('Launches')
    await ann.ok('DELETE', `/api/board-templates/${saved.body.template.id}`)
    expect(await boardTemplates(ann)).toEqual([])
    // The board made from it is untouched.
    expect((await load(ann, made.id)).data.columns).toHaveLength(4)
  })

  it('of a workspace’s board are the workspace’s: its members start boards from them, its admins look after them', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const bob = await Person.signUp(t.app, 'Bob')
    const sam = await Person.signUp(t.app, 'Sam')
    const { id: ws } = await ann.ok('POST', '/api/workspaces', { name: 'Acme' })
    await ann.ok('POST', `/api/workspaces/${ws}/invitations`, { email: 'bob@example.com' })
    const stage = (await ann.ok('POST', `/api/workspaces/${ws}/fields`, { name: 'Stage', type: 'text' })).id as string
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Client work', template: 'example', workspaceId: ws })
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: stage }] })
    const saved = (await saveBoard(ann, id, { name: 'A client' })).body.template
    expect(saved).toMatchObject({ workspaceId: ws, fields: 1, canChange: true })
    // Everyone in the workspace sees it there; it isn't among anyone's own; a stranger sees none of it.
    expect((await boardTemplates(bob, ws)).map((x) => [x.name, x.canChange])).toEqual([['A client', false]])
    expect(await boardTemplates(ann)).toEqual([])
    expect((await sam.request('GET', `/api/board-templates?workspace=${ws}`)).status).toBe(404)
    // A member makes a board from it in the workspace: the workspace's field is there already, so nothing is added.
    const made = await bob.ok<{ id: string; added: string[] }>('POST', '/api/boards', { name: 'Acme Ltd', templateId: saved.id, workspaceId: ws })
    expect(made.added).toEqual([])
    expect((await load(bob, made.id)).data.fields.map((f) => f.id)).toEqual([stage])
    // In his own Personal space it needs the field in his own library: added there, since it is his.
    const own = await bob.ok<{ id: string; added: string[] }>('POST', '/api/boards', { name: 'Side job', templateId: saved.id })
    expect(own.added).toEqual(['Stage'])
    // Only whoever saved it, or an admin, changes it. Bob's own board of the workspace saves a template of his.
    expect((await bob.request('DELETE', `/api/board-templates/${saved.id}`)).status).toBe(403)
    expect((await saveBoard(bob, made.id, { replace: saved.id })).status).toBe(403)
    const bobs = (await saveBoard(bob, made.id, { name: 'Bob’s way' })).body.template
    expect((await boardTemplates(ann, ws)).map((x) => [x.name, x.canChange])).toEqual([
      ['A client', true],
      ['Bob’s way', true],
    ])
    await ann.ok('DELETE', `/api/board-templates/${bobs.id}`)
    expect((await boardTemplates(bob, ws)).map((x) => x.name)).toEqual(['A client'])
  })
})
