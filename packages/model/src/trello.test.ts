import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { indexFor } from './indexer'
import { guessCategory } from './listNames'
import { repairData } from './migrate'
import { BoardDataSchema } from './schema'
import { COMPLETE_IN_TRELLO, TRELLO_MAX_TASKS, fromTrello, isTrelloExport, slimTrello } from './trello'
import type { Task } from './types'

const NOW = '2026-10-06T10:00:00.000Z'
const opts = () => {
  let n = 0
  return { boardId: 'board-1', now: NOW, newId: () => `n${++n}`, zone: 'Asia/Bangkok' }
}

/** A Trello id made at a given moment (its first eight characters are the second it was made). */
const tid = (at: string, tail: string) => Math.floor(Date.parse(at) / 1000).toString(16) + tail.padStart(16, '0')
const CARD_MADE = '2026-03-01T08:00:00.000Z'

const list = (id: string, name: string, pos: number, closed = false) => ({ id, name, pos, closed, idBoard: 'b', subscribed: false })
const card = (id: string, name: string, idList: string, pos: number, more: Record<string, unknown> = {}) => ({
  id,
  name,
  desc: '',
  closed: false,
  idList,
  idLabels: [],
  idMembers: [],
  idChecklists: [],
  pos,
  due: null,
  start: null,
  dueComplete: false,
  dateLastActivity: '2026-09-01T09:30:00.000Z',
  badges: { comments: 0 },
  attachments: [],
  customFieldItems: [],
  ...more,
})
const comment = (idCard: string, text: string, date: string, fullName = 'Ann Lee', type = 'commentCard') => ({
  id: `a-${date}`,
  type,
  date,
  data: { text, card: { id: idCard, name: 'x' }, board: { id: 'b' } },
  memberCreator: { id: 'm1', fullName, username: 'ann' },
})

/** A hand-made export with one of everything the converter has a rule for. */
const sample = () => ({
  id: 'b',
  name: 'Launch plan',
  desc: 'What we ship in October.',
  closed: false,
  prefs: { background: 'purple', permissionLevel: 'private' },
  shortLink: 'abc123',
  labelNames: {},
  lists: [
    list('l-done', 'Done ✅', 300),
    list('l-todo', 'To do', 100),
    list('l-doing', 'กำลังทำ', 200),
    list('l-old', 'Old ideas', 150, true),
    list('l-odd', 'Marketing', 400),
  ],
  labels: [
    { id: 'lb-bug', name: 'Bug', color: 'red_dark' },
    { id: 'lb-plain', name: '', color: 'purple' },
    { id: 'lb-unused', name: '', color: 'green' },
    { id: 'lb-nocolor', name: 'Later', color: null },
  ],
  members: [
    { id: 'm1', fullName: 'Ann Lee', username: 'ann' },
    { id: 'm2', fullName: '', username: 'ben' },
  ],
  customFields: [
    {
      id: 'cf-stage',
      name: 'Stage',
      type: 'list',
      pos: 1,
      options: [
        { id: 'o-new', value: { text: 'New' }, color: 'blue', pos: 1 },
        { id: 'o-won', value: { text: 'Won' }, color: 'green', pos: 2 },
      ],
    },
    { id: 'cf-value', name: 'Value', type: 'number', pos: 2 },
    { id: 'cf-priority', name: 'Priority', type: 'text', pos: 3 },
    { id: 'cf-signed', name: 'Signed', type: 'checkbox', pos: 4 },
    { id: 'cf-close', name: 'Close date', type: 'date', pos: 5 },
  ],
  checklists: [
    {
      id: 'ck-1',
      idCard: tid(CARD_MADE, '1'),
      name: 'Steps',
      pos: 1,
      checkItems: [
        { id: 'i2', name: 'Second step', state: 'incomplete', pos: 2, due: '2026-10-20T10:00:00.000Z' },
        { id: 'i1', name: 'First step', state: 'complete', pos: 1 },
      ],
    },
    { id: 'ck-2a', idCard: tid(CARD_MADE, '2'), name: 'Before', pos: 1, checkItems: [{ id: 'i3', name: 'Book a room', state: 'complete', pos: 1 }] },
    {
      id: 'ck-2b',
      idCard: tid(CARD_MADE, '2'),
      name: 'After',
      pos: 2,
      checkItems: [
        { id: 'i4', name: 'Send notes', state: 'incomplete', pos: 1 },
        { id: 'i5', name: 'Thank everyone', state: 'complete', pos: 2 },
      ],
    },
    { id: 'ck-empty', idCard: tid(CARD_MADE, '3'), name: 'Nothing in it', pos: 1, checkItems: [] },
  ],
  cards: [
    card(tid(CARD_MADE, '2'), 'Kick-off meeting', 'l-todo', 200),
    card(tid(CARD_MADE, '1'), 'Write the plan', 'l-todo', 100, {
      desc: 'The **plan**.',
      idLabels: ['lb-bug', 'lb-plain', 'lb-gone'],
      idMembers: ['m1', 'm2', 'm-gone'],
      due: '2026-10-15T07:30:45.123Z',
      // (Bangkok is seven hours ahead: this moment is already the 2nd there.)
      start: '2026-10-01T18:00:00.000Z',
      badges: { comments: 5 },
      attachments: [
        { name: 'Spec [v2]', url: 'https://example.com/spec (final).pdf', isUpload: false },
        { name: 'https://example.com/bare', url: 'https://example.com/bare', isUpload: false },
        { name: 'photo.png', url: 'https://trello.com/1/cards/x/attachments/y/download/photo.png', isUpload: true },
      ],
      customFieldItems: [
        { idCustomField: 'cf-stage', idValue: 'o-won', value: null },
        { idCustomField: 'cf-value', value: { number: '1200.5' } },
        { idCustomField: 'cf-priority', value: { text: ' High ' } },
        { idCustomField: 'cf-signed', value: { checked: 'true' } },
        { idCustomField: 'cf-close', value: { date: '2026-11-01T05:00:00.000Z' } },
      ],
    }),
    card(tid(CARD_MADE, '3'), 'Ship it', 'l-doing', 100, { dueComplete: true }),
    card(tid(CARD_MADE, '4'), 'Already out', 'l-done', 100, { dueComplete: true }),
    card(tid(CARD_MADE, '5'), 'Put away by hand', 'l-doing', 200, { closed: true, dateLastActivity: '2026-08-08T08:08:08.000Z' }),
    card(tid(CARD_MADE, '6'), 'An old idea', 'l-old', 100),
    card(tid(CARD_MADE, '7'), 'On another board', 'l-elsewhere', 100),
    card(tid(CARD_MADE, '8'), '   ', 'l-odd', 100),
  ],
  actions: [
    comment(tid(CARD_MADE, '1'), 'Second thoughts', '2026-09-03T10:00:00.000Z'),
    comment(tid(CARD_MADE, '1'), 'First thoughts', '2026-09-02T10:00:00.000Z', '*Ben*'),
    comment(tid(CARD_MADE, '6'), 'On an archived card', '2026-09-04T10:00:00.000Z', 'Ann Lee', 'copyCommentCard'),
    comment(tid(CARD_MADE, '7'), 'On a card that didn’t come', '2026-09-05T10:00:00.000Z'),
    { id: 'a-move', type: 'updateCard', date: '2026-09-06T10:00:00.000Z', data: { card: { id: tid(CARD_MADE, '1') }, listAfter: {} } },
  ],
})

const convert = (raw: unknown = sample(), more: Partial<ReturnType<typeof opts>> & { categories?: Record<string, never | string> } = {}) =>
  fromTrello(slimTrello(raw), { ...opts(), ...more } as Parameters<typeof fromTrello>[1])
const byTitle = (tasks: Record<string, Task>, title: string) => Object.values(tasks).find((t) => t.title === title)!

describe('telling a Trello export apart', () => {
  it('knows a Trello board, and not one of ours', () => {
    expect(isTrelloExport(sample())).toBe(true)
    expect(isTrelloExport(slimTrello(sample()))).toBe(true)
    expect(isTrelloExport({ app: 'kanbanto', format: 3, data: {} })).toBe(false)
    expect(isTrelloExport({ boardName: 'x', tasks: [] })).toBe(false)
    expect(isTrelloExport([{ id: 'a', title: 't' }])).toBe(false)
    expect(isTrelloExport(null)).toBe(false)
  })

  it('slimming keeps what is used, and slimming twice changes nothing', () => {
    const slim = slimTrello(sample())
    expect(slimTrello(slim)).toEqual(slim)
    expect(JSON.stringify(slim)).not.toContain('permissionLevel')
    expect(slim.comments).toHaveLength(4)
  })

  it('a file of the wrong shapes becomes an empty board, not a crash', () => {
    const odd = {
      name: 7,
      lists: [null, 3, { id: 'l', name: null }],
      cards: [{ id: 'c', idList: 'l', attachments: 'no', badges: 4 }, 'x'],
      actions: {},
    }
    const { data, summary } = convert(odd)
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    expect(data.board.name).toBe('Trello board')
    expect(summary.cards).toBe(1)
    expect(Object.values(data.tasks)[0].title).toBe('Untitled card')
  })
})

describe('a Trello board as a board here', () => {
  it('passes the same checks as any imported board', () => {
    const { data } = convert()
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    // (Nothing in it points at something that isn't there: repairing changes nothing.)
    expect(repairData(data).tasks).toEqual(data.tasks)
  })

  it('the board: its name, what it is for, a plain background, parent status set by hand', () => {
    const { data } = convert()
    expect(data.board).toMatchObject({
      id: 'board-1',
      name: 'Launch plan',
      description: 'What we ship in October.',
      background: 'violet',
      mode: 'manual',
    })
    expect(data.members).toEqual([])
  })

  it('lists come in their order, with what each counts as guessed from its name; archived lists are not made', () => {
    const { data, summary } = convert()
    expect(data.columns.map((c) => [c.name, c.category])).toEqual([
      ['To do', 'todo'],
      ['กำลังทำ', 'doing'],
      ['Done ✅', 'done'],
      ['Marketing', 'todo'],
    ])
    expect(summary.lists.map((l) => [l.name, l.guessed, l.cards])).toEqual([
      ['To do', true, 2],
      ['กำลังทำ', true, 1],
      ['Done ✅', true, 1],
      ['Marketing', false, 1],
    ])
    expect(summary.left.closedLists).toEqual(['Old ideas'])
  })

  it('what a list counts as can be said instead of guessed', () => {
    const { data, summary } = convert(sample(), { categories: { 'l-odd': 'backlog', 'l-doing': 'todo' } })
    expect(data.columns.map((c) => c.category)).toEqual(['todo', 'todo', 'done', 'backlog'])
    expect(summary.lists.find((l) => l.id === 'l-odd')).toMatchObject({ category: 'backlog', guessed: false })
  })

  it('cards keep their place in their list, their dates and when they were made and last touched', () => {
    const { data } = convert()
    const idx = indexFor(data)
    const todo = data.columns[0].id
    const inTodo = Object.values(data.tasks)
      .filter((t) => t.status === todo && !t.parentId)
      .sort((a, b) => (a.rank! < b.rank! ? -1 : 1))
    expect(inTodo.map((t) => t.title)).toEqual(['Write the plan', 'Kick-off meeting'])
    expect(idx.roots.map((id) => data.tasks[id].title)).toEqual(['Write the plan', 'Kick-off meeting', 'Ship it', 'Already out', 'Untitled card'])
    const plan = byTitle(data.tasks, 'Write the plan')
    // A due date keeps its time (to the minute); a start is a day, where the importer is.
    expect(plan.due).toBe('2026-10-15T07:30:00Z')
    expect(plan.start).toBe('2026-10-02')
    expect(plan.createdAt).toBe(CARD_MADE)
    expect(plan.updatedAt).toBe('2026-09-01T09:30:00.000Z')
    expect(plan.activeAt).toBe(plan.updatedAt)
  })

  it('labels: the named ones and the ones in use, in the nearest colour', () => {
    const { data, summary } = convert()
    expect(data.labels.map((l) => [l.name, l.color])).toEqual([
      ['Bug', 'red'],
      ['', 'violet'],
      ['Later', 'gray'],
      [COMPLETE_IN_TRELLO, 'green'],
    ])
    expect(summary.labels).toBe(4)
    const plan = byTitle(data.tasks, 'Write the plan')
    expect(plan.labels.map((id) => data.labels.find((l) => l.id === id)!.name)).toEqual(['Bug', ''])
  })

  it('a card marked complete outside a done list gets a label saying so; in a done list it needs none', () => {
    const { data, summary } = convert()
    const label = data.labels.find((l) => l.name === COMPLETE_IN_TRELLO)!
    expect(byTitle(data.tasks, 'Ship it').labels).toEqual([label.id])
    expect(byTitle(data.tasks, 'Already out').labels).toEqual([])
    expect(summary.left.completeLabel).toBe(1)
  })

  it('who it was assigned to, its links and its uploaded files are written under the description', () => {
    const { data, summary } = convert()
    expect(byTitle(data.tasks, 'Write the plan').description).toBe(
      [
        'The **plan**.',
        'Assigned in Trello: Ann Lee, ben',
        'Links:\n- [Spec \\[v2\\]](https://example.com/spec%20%28final%29.pdf)\n- [https://example.com/bare](https://example.com/bare)',
        'Files left in Trello (they open while you’re signed in there):\n- [photo.png](https://trello.com/1/cards/x/attachments/y/download/photo.png)',
      ].join('\n\n'),
    )
    expect(summary.left).toMatchObject({ files: 1, people: 1 })
    expect(byTitle(data.tasks, 'Kick-off meeting').description).toBeUndefined()
  })

  it('one checklist: its items are the card’s subtasks, ticked ones in the done list', () => {
    const { data, summary } = convert()
    const idx = indexFor(data)
    const plan = byTitle(data.tasks, 'Write the plan')
    const subs = idx.childrenOf.get(plan.id)!.map((id) => data.tasks[id])
    const done = data.columns.find((c) => c.category === 'done')!.id
    expect(subs.map((t) => [t.title, t.status === done, t.due])).toEqual([
      ['First step', true, undefined],
      ['Second step', false, '2026-10-20T10:00:00Z'],
    ])
    // An unticked item waits where its card is.
    expect(subs[1].status).toBe(plan.status)
    expect(summary.subtasks).toBe(7)
    expect(summary.left.doneListAdded).toBe(false)
  })

  it('several checklists: a subtask each, done when every item is', () => {
    const { data } = convert()
    const idx = indexFor(data)
    const kick = byTitle(data.tasks, 'Kick-off meeting')
    const done = data.columns.find((c) => c.category === 'done')!.id
    const groups = idx.childrenOf.get(kick.id)!.map((id) => data.tasks[id])
    expect(groups.map((t) => [t.title, t.status === done])).toEqual([
      ['Before', true],
      ['After', false],
    ])
    expect(idx.childrenOf.get(groups[1].id)!.map((id) => [data.tasks[id].title, data.tasks[id].status === done])).toEqual([
      ['Send notes', false],
      ['Thank everyone', true],
    ])
  })

  it('a board with no done list gets one, only when a ticked item needs it', () => {
    const raw = sample()
    raw.lists = raw.lists.filter((l) => l.id !== 'l-done')
    const { data, summary } = convert(raw)
    expect(data.columns.map((c) => c.name)).toEqual(['To do', 'กำลังทำ', 'Marketing', 'Done'])
    expect(summary.left.doneListAdded).toBe(true)
    expect(summary.lists.map((l) => l.name)).toEqual(['To do', 'กำลังทำ', 'Marketing'])
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    const none = convert({ ...raw, checklists: [] })
    expect(none.data.columns.map((c) => c.name)).toEqual(['To do', 'กำลังทำ', 'Marketing'])
    expect(none.summary.left.doneListAdded).toBe(false)
  })

  it('an unticked item of a card in a done list waits in the first list that isn’t one', () => {
    const raw = sample()
    raw.checklists = [
      { id: 'ck', idCard: tid(CARD_MADE, '4'), name: 'Late', pos: 1, checkItems: [{ id: 'i', name: 'Tidy up', state: 'incomplete', pos: 1 }] },
    ]
    const { data } = convert(raw)
    expect(byTitle(data.tasks, 'Tidy up').status).toBe(data.columns[0].id)
  })

  it('archived cards, and the cards of archived lists, arrive archived with the list they were in', () => {
    const { data, summary } = convert()
    expect(summary).toMatchObject({ cards: 5, archived: 2 })
    const away = Object.values(data.archived!)
    expect(away.map((t) => [t.title, t.archivedList, t.archivedDone, t.archivedAt]).sort()).toEqual([
      ['An old idea', 'Old ideas', false, '2026-09-01T09:30:00.000Z'],
      ['Put away by hand', 'กำลังทำ', false, '2026-08-08T08:08:08.000Z'],
    ])
    // Each has a list to come back to.
    expect(away.every((t) => data.columns.some((c) => c.id === t.status))).toBe(true)
    expect(byTitle(data.tasks, 'An old idea')).toBeUndefined()
    // A card on a list the file doesn't have isn't this board's.
    expect([...Object.values(data.tasks), ...away].some((t) => t.title === 'On another board')).toBe(false)
  })

  it('an archived card’s checklist is archived with it', () => {
    const raw = sample()
    raw.checklists = [
      { id: 'ck', idCard: tid(CARD_MADE, '6'), name: 'x', pos: 1, checkItems: [{ id: 'i', name: 'Was done', state: 'complete', pos: 1 }] },
    ]
    const { data } = convert(raw)
    const sub = byTitle(data.archived!, 'Was done')
    expect(sub).toMatchObject({ archivedDone: true, archivedList: 'Done ✅', parentId: byTitle(data.archived!, 'An old idea').id })
    expect(byTitle(data.tasks, 'Was done')).toBeUndefined()
  })

  it('comments come oldest first, saying who wrote them, with their dates; the ones Trello left out are counted', () => {
    const { data, comments, summary } = convert()
    const plan = byTitle(data.tasks, 'Write the plan')
    expect(comments).toEqual([
      { taskId: plan.id, body: '**\\*Ben\\*** wrote in Trello:\n\nFirst thoughts', at: '2026-09-02T10:00:00.000Z' },
      { taskId: plan.id, body: '**Ann Lee** wrote in Trello:\n\nSecond thoughts', at: '2026-09-03T10:00:00.000Z' },
      {
        taskId: byTitle(data.archived!, 'An old idea').id,
        body: '**Ann Lee** wrote in Trello:\n\nOn an archived card',
        at: '2026-09-04T10:00:00.000Z',
      },
    ])
    expect(summary.comments).toBe(3)
    // The card says it has five; the file holds two.
    expect(summary.left.missingComments).toBe(3)
  })

  it('custom fields become fields, with their values; a name every card already has says where it came from', () => {
    const { data, summary } = convert()
    expect(data.fields.map((f) => [f.name, f.type])).toEqual([
      ['Stage', 'choice'],
      ['Value', 'number'],
      ['Priority (Trello)', 'text'],
      ['Signed', 'checkbox'],
      ['Close date', 'date'],
    ])
    expect(summary.fields).toEqual(['Stage', 'Value', 'Priority (Trello)', 'Signed', 'Close date'])
    const [stage, value, priority, signed, close] = data.fields
    expect(stage.options!.map((o) => [o.name, o.color])).toEqual([
      ['New', 'blue'],
      ['Won', 'green'],
    ])
    expect(byTitle(data.tasks, 'Write the plan').custom).toEqual({
      [stage.id]: [stage.options![1].id],
      [value.id]: 1200.5,
      [priority.id]: 'High',
      [signed.id]: true,
      [close.id]: '2026-11-01T05:00:00Z',
    })
    expect(byTitle(data.tasks, 'Ship it').custom).toBeUndefined()
  })

  it('fields past what one board holds are written on the cards', () => {
    const raw = sample()
    const many = Array.from({ length: 22 }, (_, i) => ({ id: `cf-${i}`, name: `Field ${i + 1}`, type: 'text', pos: i }))
    raw.customFields = many as never
    raw.cards[1].customFieldItems = [
      { idCustomField: 'cf-0', value: { text: 'kept' } },
      { idCustomField: 'cf-20', value: { text: 'as words' } },
      { idCustomField: 'cf-21', value: { text: '' } },
    ] as never
    const { data, summary } = convert(raw)
    expect(data.fields).toHaveLength(20)
    expect(summary.left.fieldsAsText).toEqual(['Field 21', 'Field 22'])
    const plan = byTitle(data.tasks, 'Write the plan')
    expect(plan.custom).toEqual({ [data.fields[0].id]: 'kept' })
    expect(plan.description!.endsWith('\n\nField 21: as words')).toBe(true)
  })

  it('texts too long to hold are shortened, and counted', () => {
    const raw = sample()
    raw.cards[0].name = 'T'.repeat(700)
    raw.cards[1].desc = 'D'.repeat(60_000)
    ;(raw.actions[0].data as { text: string }).text = 'C'.repeat(12_000)
    const { data, comments, summary } = convert(raw)
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    expect(Object.values(data.tasks).some((t) => t.title.length === 500 && t.title.endsWith('…'))).toBe(true)
    const plan = byTitle(data.tasks, 'Write the plan')
    expect(plan.description!.length).toBeLessThanOrEqual(50_000)
    // (What was added under it is whole.)
    expect(plan.description).toContain('Files left in Trello')
    expect(comments.every((c) => c.body.length <= 10_000)).toBe(true)
    expect(summary.left.cut).toBe(3)
  })

  it('a board too big to import says so', () => {
    const raw = sample()
    raw.cards = Array.from({ length: TRELLO_MAX_TASKS + 1 }, (_, i) => card(`c${i}`, `Card ${i}`, 'l-todo', i)) as never
    expect(() => convert(raw)).toThrow(/too big/)
  })

  it('a board whose lists are all archived still has a list', () => {
    const raw = sample()
    raw.lists = raw.lists.map((l) => ({ ...l, closed: true }))
    const { data, summary } = convert({ ...raw, checklists: [] })
    expect(data.columns.map((c) => c.name)).toEqual(['To Do'])
    expect(summary.cards).toBe(0)
    expect(summary.archived).toBe(7)
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
  })
})

describe('what a list counts as, from its name', () => {
  it('reads English and Thai names', () => {
    const cases: [string, ReturnType<typeof guessCategory>][] = [
      ['To Do', 'todo'],
      ['TODO', 'todo'],
      ['Not started', 'todo'],
      ['Up next', 'todo'],
      ['This week', 'todo'],
      ['Doing', 'doing'],
      ['In Progress 🚧', 'doing'],
      ['In review', 'doing'],
      ['QA', 'doing'],
      ['Done', 'done'],
      ['Completed', 'done'],
      ['Shipped!', 'done'],
      ['Won’t do', 'done'],
      ['Dropped', 'done'],
      ['Backlog', 'backlog'],
      ['Ideas', 'backlog'],
      ['Someday / maybe', 'backlog'],
      ['สิ่งที่ต้องทำ', 'todo'],
      ['กำลังดำเนินการ', 'doing'],
      ['เสร็จแล้ว', 'done'],
      ['ไม่เอา', 'done'],
      ['ไอเดีย', 'backlog'],
      ['ดูดี แต่รอก่อน', 'backlog'],
      ['Screening', null],
      ['Marketing', null],
      ['Undone-ish', null],
      ['', null],
    ]
    for (const [name, want] of cases) expect([name, guessCategory(name)]).toEqual([name, want])
  })
})

// A real export, when one is given (TRELLO_EXPORT=/path/to/board.json): never kept in the repository.
describe.skipIf(!process.env.TRELLO_EXPORT)('a real Trello export', () => {
  it('becomes a valid board, with every card and comment the file holds', () => {
    const raw = JSON.parse(readFileSync(process.env.TRELLO_EXPORT!, 'utf8')) as {
      cards: { idList: string }[]
      lists: { id: string }[]
      actions: { type: string }[]
    }
    expect(isTrelloExport(raw)).toBe(true)
    const slim = slimTrello(raw)
    const { data, comments, summary } = fromTrello(slim, opts())
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    expect(repairData(data).tasks).toEqual(data.tasks)
    const lists = new Set(raw.lists.map((l) => l.id))
    expect(summary.cards + summary.archived).toBe(raw.cards.filter((c) => lists.has(c.idList)).length)
    expect(comments.length + summary.left.missingComments).toBeGreaterThanOrEqual(raw.actions.filter((a) => a.type === 'commentCard').length)
    console.log(
      JSON.stringify({
        ...summary,
        lists: summary.lists.map((l) => `${l.category}${l.guessed ? '*' : ''}:${l.cards}`),
        slimKB: Math.round(JSON.stringify(slim).length / 1024),
      }),
    )
  })
})
