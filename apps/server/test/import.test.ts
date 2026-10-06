import { readFileSync } from 'node:fs'
import type { BoardData, Task } from '@kanbanto/model/types'
import type { TrelloSummary } from '@kanbanto/model/trello'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { invertChanges } from '@kanbanto/model/changes'
import type { ImportReport } from '@kanbanto/model/importCards'
import type { Change } from '@kanbanto/model/records'
import { mid, Person, reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const load = (p: Person, id: string) => p.ok<{ data: BoardData; seq: number }>('GET', `/api/boards/${id}?archived=all`)
const titled = (tasks: Record<string, Task> | undefined, title: string) => Object.values(tasks ?? {}).find((x) => x.title === title)!
type Imported = { id: string; lost: string[]; trello: TrelloSummary }

/** A small Trello export (the converter's own tests cover every rule: these are about what the server saves). */
const trello = () => ({
  name: 'Launch plan',
  desc: 'What we ship.',
  prefs: { background: 'blue' },
  lists: [
    { id: 'l1', name: 'To do', pos: 1, closed: false },
    { id: 'l2', name: 'Review board', pos: 2, closed: false },
    { id: 'l3', name: 'Shelved', pos: 3, closed: true },
  ],
  labels: [{ id: 'lb1', name: 'Bug', color: 'red' }],
  members: [{ id: 'm1', fullName: 'Old Colleague', username: 'old' }],
  customFields: [
    { id: 'cf1', name: 'Stage', type: 'list', pos: 1, options: [{ id: 'o1', value: { text: 'Won' }, color: 'green', pos: 1 }] },
    { id: 'cf2', name: 'Value', type: 'number', pos: 2 },
  ],
  checklists: [
    {
      id: 'k1',
      idCard: 'c1',
      name: 'Steps',
      pos: 1,
      checkItems: [
        { id: 'i1', name: 'Draft', state: 'complete', pos: 1 },
        { id: 'i2', name: 'Send', state: 'incomplete', pos: 2 },
      ],
    },
  ],
  cards: [
    {
      id: 'c1',
      name: 'Write the plan',
      desc: 'The plan.',
      idList: 'l1',
      pos: 1,
      idLabels: ['lb1'],
      idMembers: ['m1'],
      due: '2026-10-15T07:30:00.000Z',
      dateLastActivity: '2026-09-01T09:30:00.000Z',
      badges: { comments: 3 },
      attachments: [{ name: 'photo.png', url: 'https://trello.com/1/cards/c1/attachments/a/download/photo.png', isUpload: true }],
      customFieldItems: [
        { idCustomField: 'cf1', idValue: 'o1' },
        { idCustomField: 'cf2', value: { number: '250' } },
      ],
    },
    { id: 'c2', name: 'Look it over', idList: 'l2', pos: 1, dateLastActivity: '2026-09-02T09:30:00.000Z' },
    { id: 'c3', name: 'Put away', idList: 'l3', pos: 1, dateLastActivity: '2026-08-01T09:30:00.000Z' },
  ],
  actions: [
    {
      type: 'commentCard',
      date: '2026-09-03T10:00:00.000Z',
      data: { text: 'Looks good @old', card: { id: 'c1' } },
      memberCreator: { fullName: 'Old Colleague' },
    },
    {
      type: 'commentCard',
      date: '2026-09-02T10:00:00.000Z',
      data: { text: 'First', card: { id: 'c1' } },
      memberCreator: { fullName: 'Old Colleague' },
    },
    {
      type: 'commentCard',
      date: '2026-08-02T10:00:00.000Z',
      data: { text: 'On the shelf', card: { id: 'c3' } },
      memberCreator: { fullName: 'Old Colleague' },
    },
    { type: 'updateCard', date: '2026-09-04T10:00:00.000Z', data: { card: { id: 'c1' } } },
  ],
})

describe('importing a Trello board', () => {
  it('makes a board of your own: lists, cards, subtasks, archived cards, and what the answer says came over', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok<Imported>('POST', '/api/boards/import', { file: trello() })
    expect(made.lost).toEqual([])
    expect(made.trello).toMatchObject({
      name: 'Launch plan',
      cards: 2,
      archived: 1,
      subtasks: 2,
      labels: 1,
      comments: 3,
      fields: ['Stage', 'Value'],
      left: { closedLists: ['Shelved'], files: 1, people: 1, missingComments: 1, doneListAdded: true },
    })
    expect(made.trello.lists.map((l) => [l.name, l.category, l.guessed])).toEqual([
      ['To do', 'todo', true],
      ['Review board', 'doing', true],
    ])

    const { boards } = await ann.ok('GET', '/api/boards')
    expect(boards.find((b: { id: string }) => b.id === made.id)).toMatchObject({ name: 'Launch plan', role: 'owner', workspaceId: null })
    const { data } = await load(ann, made.id)
    expect(data.board).toMatchObject({ name: 'Launch plan', mode: 'manual', description: 'What we ship.', background: 'blue' })
    expect(data.columns.map((c) => [c.name, c.category])).toEqual([
      ['To do', 'todo'],
      ['Review board', 'doing'],
      ['Done', 'done'],
    ])
    const plan = titled(data.tasks, 'Write the plan')
    expect(plan).toMatchObject({ due: '2026-10-15T07:30:00Z', status: data.columns[0].id, labels: [data.labels[0].id] })
    expect(plan.description).toContain('Assigned in Trello: Old Colleague')
    expect(plan.description).toContain('Files left in Trello')
    expect(plan.assigneeId).toBeUndefined()
    // A ticked item is in the done list (and counts as done since the card was last touched); the other waits with its card.
    expect(titled(data.tasks, 'Draft')).toMatchObject({ parentId: plan.id, status: data.columns[2].id, doneAt: '2026-09-01T09:30:00.000Z' })
    expect(titled(data.tasks, 'Send')).toMatchObject({ parentId: plan.id, status: data.columns[0].id })
    expect(titled(data.archived, 'Put away')).toMatchObject({ archivedList: 'Shelved', archivedDone: false })
    expect(titled(data.tasks, 'Put away')).toBeUndefined()
  })

  it('comments are yours, say who wrote them, keep their dates and tell nobody', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok<Imported>('POST', '/api/boards/import', { file: trello() })
    const { data } = await load(ann, made.id)
    const plan = titled(data.tasks, 'Write the plan')
    const { comments } = await ann.ok('GET', `/api/boards/${made.id}/tasks/${plan.id}/comments`)
    expect(
      comments.map((c: { body: string; createdAt: string; author: { id: string }; mentions: string[] }) => [
        c.body,
        c.createdAt,
        c.author.id,
        c.mentions,
      ]),
    ).toEqual([
      ['**Old Colleague** wrote in Trello:\n\nFirst', '2026-09-02T10:00:00.000Z', ann.user.id, []],
      ['**Old Colleague** wrote in Trello:\n\nLooks good @old', '2026-09-03T10:00:00.000Z', ann.user.id, []],
    ])
    // An archived card keeps what was said on it.
    const shelf = await ann.ok('GET', `/api/boards/${made.id}/tasks/${titled(data.archived, 'Put away').id}/comments`)
    expect(shelf.comments).toHaveLength(1)
    expect((await ann.ok('GET', '/api/notifications')).notifications).toEqual([])
    // The board shows how many each card has.
    const board = await ann.ok('GET', `/api/boards/${made.id}`)
    expect(board.counts.comments[plan.id]).toBe(2)
  })

  it('what a list counts as can be said', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok<Imported>('POST', '/api/boards/import', { file: trello(), lists: { l2: 'done' } })
    const { data } = await load(ann, made.id)
    expect(data.columns.map((c) => [c.name, c.category])).toEqual([
      ['To do', 'todo'],
      ['Review board', 'done'],
    ])
    expect(made.trello.left.doneListAdded).toBe(false)
    expect((await ann.request('POST', '/api/boards/import', { file: trello(), lists: { l2: 'finished' } })).status).toBe(400)
  })

  it('its custom fields become fields of yours, once; a second import uses the same ones', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const first = await ann.ok<Imported>('POST', '/api/boards/import', { file: trello() })
    const mine = (await ann.ok('GET', '/api/fields')).fields
    expect(mine.map((f: { name: string; type: string }) => [f.name, f.type])).toEqual([
      ['Stage', 'choice'],
      ['Value', 'number'],
    ])
    const { data } = await load(ann, first.id)
    const [stage, value] = data.fields
    expect(titled(data.tasks, 'Write the plan').custom).toEqual({ [stage.id]: [stage.options![0].id], [value.id]: 250 })
    const second = await ann.ok<Imported>('POST', '/api/boards/import', { file: trello() })
    expect((await ann.ok('GET', '/api/fields')).fields).toHaveLength(2)
    expect(titled((await load(ann, second.id)).data.tasks, 'Write the plan').custom).toEqual({ [stage.id]: [stage.options![0].id], [value.id]: 250 })
  })

  it('a field there is no room for is written on its cards, and named in what was lost', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    for (let i = 0; i < 49; i++) await ann.ok('POST', '/api/fields', { name: `F${i}`, type: 'text' })
    const made = await ann.ok<Imported>('POST', '/api/boards/import', { file: trello() })
    expect(made.lost).toEqual(['Value'])
    const { data } = await load(ann, made.id)
    expect(data.fields.map((f) => f.name)).toEqual(['Stage'])
    const plan = titled(data.tasks, 'Write the plan')
    expect(plan.description!.endsWith('\n\nValue: 250')).toBe(true)
    expect(Object.keys(plan.custom ?? {})).toEqual([data.fields[0].id])
  })

  it('a file that is neither is still refused, and a Trello file of odd shapes doesn’t break anything', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    expect((await ann.request('POST', '/api/boards/import', { file: { hello: 1 } })).body.error).toMatch(/isn’t a board/)
    const odd = await ann.ok<Imported>('POST', '/api/boards/import', {
      file: { name: 'Odd', lists: [3, null], cards: [7, { id: 'c' }], actions: 'x' },
    })
    const { data } = await load(ann, odd.id)
    expect(data.columns.map((c) => c.name)).toEqual(['To Do'])
    expect(Object.keys(data.tasks)).toEqual([])
    const signedOut = new Person(t.app)
    expect((await signedOut.request('POST', '/api/boards/import', { file: trello() })).status).toBe(401)
  })
})

/** Ann owns a board; Bob (editor) and Vic (viewer) are on it. */
async function team() {
  const ann = await Person.signUp(t.app, 'Ann')
  const { id } = await ann.ok('POST', '/api/boards', { name: 'Deals' })
  const bob = await Person.signUp(t.app, 'Bob')
  const vic = await Person.signUp(t.app, 'Vic')
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'bob@example.com', role: 'editor' })
  await ann.ok('POST', `/api/boards/${id}/invitations`, { email: 'vic@example.com', role: 'viewer' })
  return { ann, bob, vic, id }
}
type Added = { columns: string[]; report: ImportReport; added: number; seq?: number; changes?: Change[] }
const sheet = (...lines: string[][]) => lines.map((l) => l.join('\t')).join('\n')
const bring = (p: Person, id: string, body: object) => p.ok<Added>('POST', `/api/boards/${id}/tasks/import`, body)
const bell = async (p: Person) =>
  (await p.ok('GET', '/api/notifications')).notifications.filter((n: { kind: string }) => n.kind !== 'added') as {
    kind: string
    changes?: string[]
    actor: string
  }[]

describe('cards from a spreadsheet', () => {
  it('the check says what would happen and changes nothing; then the cards are added as one change', async () => {
    const { ann, id } = await team()
    const text = sheet(
      ['Task', 'Status', 'Deadline', 'Tags', 'Notes'],
      ['Call Acme', 'Doing', '31/10/2026', 'Sales, Hot', 'Ask about the renewal'],
      ['', 'Doing', '', '', 'no title here'],
      ['Send quote', 'Waiting', 'whenever', '', ''],
    )
    const before = await load(ann, id)
    const check = await bring(ann, id, { text, dryRun: true })
    expect(check.columns).toEqual(['title', 'list', 'due', 'labels', 'description'])
    expect(check).toMatchObject({ added: 0, report: { cards: 2, lists: ['Waiting'], labels: ['Sales', 'Hot'], noTitle: [3], duplicates: [] } })
    expect(check.report.problems).toMatchObject([{ column: 'Deadline', kind: 'date', rows: [4], samples: ['whenever'] }])
    expect(check.changes).toBeUndefined()
    expect((await load(ann, id)).seq).toBe(before.seq)

    const done = await bring(ann, id, { text })
    expect(done).toMatchObject({ added: 2, seq: before.seq + 1, report: check.report })
    const { data } = await load(ann, id)
    expect(data.columns.map((c) => c.name)).toEqual(['Backlog', 'To Do', 'Doing', 'Done', 'Waiting'])
    expect(titled(data.tasks, 'Call Acme')).toMatchObject({
      due: '2026-10-31',
      description: 'Ask about the renewal',
      status: data.columns[2].id,
      labels: data.labels.map((l) => l.id),
    })
    expect(titled(data.tasks, 'Send quote')).toMatchObject({ status: data.columns[4].id })
    const { activity } = await ann.ok('GET', `/api/boards/${id}/activity`)
    expect(activity[0]).toMatchObject({ command: 'tasks.import', items: [{ text: 'imported 2 cards' }, { text: 'added the list “Waiting”' }] })

    // Done again, the same rows are already cards: nothing is added twice.
    const again = await bring(ann, id, { text })
    expect(again).toMatchObject({ added: 0, report: { cards: 0, duplicates: [2, 4] } })
    expect(await bring(ann, id, { text, addAnyway: true })).toMatchObject({ added: 2 })
  })

  it('the same request sent twice adds once, and one undo takes the cards away', async () => {
    const { ann, id } = await team()
    // (Asked to add rows whatever is on the board, so only the request's own id stops the second one.)
    const body = { text: sheet(['Title', 'List'], ['One', 'Fresh'], ['Two', '']), mutationId: mid(), addAnyway: true }
    const first = await bring(ann, id, body)
    const second = await bring(ann, id, body)
    expect([first.added, second.added, second.seq]).toEqual([2, 2, first.seq])
    const after = await load(ann, id)
    expect(Object.keys(after.data.tasks)).toHaveLength(2)
    const inverse = invertChanges(after.data, first.changes!, new Date().toISOString())
    await ann.ok('POST', `/api/boards/${id}/mutations`, { mutationId: mid(), command: { type: 'records.restore', changes: inverse } })
    const undone = await load(ann, id)
    expect(Object.keys(undone.data.tasks)).toEqual([])
    expect(undone.data.columns.map((c) => c.name)).toEqual(['Backlog', 'To Do', 'Doing', 'Done'])
  })

  it('each assignee is told once, by name or by address, and follows what is theirs', async () => {
    const { ann, bob, id } = await team()
    const done = await bring(ann, id, {
      text: sheet(
        ['Title', 'Assignee', 'Notes'],
        ['First', 'bob@example.com', 'ask @Bob'],
        ['Second', 'bob', ''],
        ['Third', 'BOB', ''],
        ['Mine', 'Ann', ''],
        ['Whose', 'Zed', ''],
      ),
    })
    expect(done.added).toBe(5)
    expect(done.report.problems).toMatchObject([{ column: 'Assignee', kind: 'person', rows: [6], samples: ['Zed'] }])
    expect(await bell(bob)).toMatchObject([{ kind: 'change', actor: 'Ann', changes: ['assigned “First” and 2 more cards to you'] }])
    expect(await bell(ann)).toEqual([])
    const { data } = await load(ann, id)
    const follows = async (p: Person, title: string) =>
      (await p.ok('GET', `/api/boards/${id}/tasks/${titled(data.tasks, title).id}/follow`)).following
    expect([await follows(bob, 'Third'), await follows(ann, 'Mine'), await follows(ann, 'First')]).toEqual([true, true, false])
    // One card for one person reads like any assignment.
    await bring(ann, id, { text: sheet(['Title', 'Assignee'], ['Solo', 'Bob']) })
    expect((await bell(bob))[0]).toMatchObject({ changes: ['assigned “Solo” to you'] })
  })

  it('dates that read two ways have to be settled first', async () => {
    const { ann, id } = await team()
    const text = sheet(['Title', 'Due'], ['One', '3/4/2026'], ['Two', '5/6/2026'])
    const check = await bring(ann, id, { text, dryRun: true })
    expect(check.report.askDateOrder).toEqual({ column: 'Due', sample: '3/4/2026' })
    const refused = await ann.request('POST', `/api/boards/${id}/tasks/import`, { text })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toMatch(/dateOrder/)
    expect(Object.keys((await load(ann, id)).data.tasks)).toEqual([])
    await bring(ann, id, { text, dateOrder: 'mdy' })
    expect(titled((await load(ann, id)).data.tasks, 'One').due).toBe('2026-03-04')
  })

  it('the board’s own fields, by name: values, a card found by its title, and a new option for whoever manages the field', async () => {
    const { ann, bob, id } = await team()
    const { id: clients } = await ann.ok('POST', '/api/boards', { name: 'Clients' })
    await ann.ok('POST', `/api/boards/${clients}/mutations`, {
      mutationId: mid(),
      command: { type: 'task.create', id: 'acme', parentId: null, fields: { title: 'Acme Co' } },
    })
    const add = async (body: object) => (await ann.ok('POST', '/api/fields', body)).id as string
    const value = await add({ name: 'Value', type: 'number' })
    const stage = await add({ name: 'Stage', type: 'choice', options: [{ name: 'Lead', color: 'gray' }] })
    const client = await add({ name: 'Client', type: 'link', linkTo: 'board', board: clients })
    await ann.ok('PUT', `/api/boards/${id}/fields`, { fields: [{ id: value }, { id: stage }, { id: client }] })
    const text = sheet(
      ['Deal', 'Value', 'Stage', 'Client'],
      ['Renewal', '฿12,500', 'Negotiating', 'acme co'],
      ['Upsell', 'n/a', 'lead', 'Nobody Ltd'],
    )

    // Bob edits the board but doesn't manage Ann's fields: no new option for him.
    const bobs = await bring(bob, id, { text, dryRun: true })
    expect(bobs.columns).toEqual(['title', `f:${value}`, `f:${stage}`, `f:${client}`])
    expect(bobs.report.options).toEqual([])
    expect(bobs.report.problems.map((p) => [p.column, p.kind, p.rows])).toEqual([
      ['Stage', 'option', [2]],
      // (The Clients board is Ann's alone: Bob can't link its cards.)
      ['Client', 'link', [2, 3]],
      ['Value', 'number', [3]],
    ])

    const anns = await bring(ann, id, { text, columns: ['title', 'value', 'Stage', `f:${client}`] })
    expect(anns.report.options).toEqual([{ field: 'Stage', names: ['Negotiating'] }])
    expect(anns.report.problems.map((p) => [p.column, p.kind, p.rows])).toEqual([
      ['Value', 'number', [3]],
      ['Client', 'link', [3]],
    ])
    const { data } = await load(ann, id)
    const options = data.fields.find((f) => f.id === stage)!.options!
    expect(options.map((o) => o.name)).toEqual(['Lead', 'Negotiating'])
    expect(titled(data.tasks, 'Renewal').custom).toEqual({ [value]: 12500, [stage]: [options[1].id], [client]: [`${clients}:acme`] })
    expect(titled(data.tasks, 'Upsell').custom).toEqual({ [stage]: [options[0].id] })
    // The library has the option too, once.
    const lib = (await ann.ok('GET', '/api/fields')).fields.find((f: { id: string }) => f.id === stage)
    expect(lib.options.map((o: { name: string }) => o.name)).toEqual(['Lead', 'Negotiating'])
  })

  it('who can, and what is refused', async () => {
    const { ann, vic, id } = await team()
    const text = sheet(['Title'], ['One'])
    const url = `/api/boards/${id}/tasks/import`
    expect((await vic.request('POST', url, { text })).status).toBe(403)
    expect((await vic.request('POST', url, { text, dryRun: true })).status).toBe(403)
    expect((await new Person(t.app).request('POST', url, { text })).status).toBe(401)
    const refusal = async (body: object) => {
      const r = await ann.request('POST', url, body)
      return [r.status, r.body.error]
    }
    expect(await refusal({ text: '  \n ' })).toEqual([400, expect.stringMatching(/nothing to import/)])
    expect(await refusal({ text, columns: ['description'] })).toEqual([400, expect.stringMatching(/which column is the title/)])
    expect(await refusal({ text, columns: ['colour'] })).toEqual([400, expect.stringMatching(/isn’t something a column can be/)])
    expect(await refusal({ text, columns: ['title'], surprise: true })).toEqual([400, expect.any(String)])
    expect(await refusal({ text: sheet(['Title', 'Title'], ['a', 'b']), columns: ['title', 'title'] })).toEqual([
      400,
      expect.stringMatching(/only be used once/),
    ])
    expect(Object.keys((await load(ann, id)).data.tasks)).toEqual([])
    // Without a row of names, said columns still work.
    expect(await bring(ann, id, { text: 'One\tx\nTwo\ty', header: false, columns: ['title', 'description'] })).toMatchObject({ added: 2 })
  })
})

// A real export, when one is given (TRELLO_EXPORT=/path/to/board.json): never kept in the repository.
describe.skipIf(!process.env.TRELLO_EXPORT)('a real Trello export', () => {
  it('imports whole, and the board loads', async () => {
    const file = JSON.parse(readFileSync(process.env.TRELLO_EXPORT!, 'utf8'))
    const ann = await Person.signUp(t.app, 'Ann')
    const made = await ann.ok<Imported>('POST', '/api/boards/import', { file })
    const { data } = await load(ann, made.id)
    expect(Object.values(data.tasks).filter((x) => !x.parentId)).toHaveLength(made.trello.cards)
    expect(Object.values(data.archived ?? {}).filter((x) => !x.parentId)).toHaveLength(made.trello.archived)
    const board = await ann.ok('GET', `/api/boards/${made.id}`)
    const shown = Object.values(board.counts.comments as Record<string, number>).reduce((a, b) => a + b, 0)
    expect(shown).toBeLessThanOrEqual(made.trello.comments)
  })
})
