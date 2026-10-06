import { describe, expect, it } from 'vitest'
import { applyChanges, invertChanges } from './changes'
import { execute, IMPORT_MAX } from './commands'
import { describeChanges } from './activity'
import { linkRef, type BoardField } from './fields'
import {
  guessColumns,
  IMPORT_NEW_LISTS,
  planCardImport,
  problemText,
  rowsText,
  type ColumnRole,
  type ImportLookups,
  type ImportOptions,
} from './importCards'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import { BoardDataSchema, CommandSchema } from './schema'
import { parseSheet } from './sheet'
import type { BoardData } from './types'

const NOW = '2026-10-06T10:00:00.000Z'
const FIELDS: BoardField[] = [
  { id: 'f-email', name: 'Email', type: 'text', format: 'email' },
  { id: 'f-value', name: 'Value', type: 'number' },
  { id: 'f-signed', name: 'Signed', type: 'checkbox' },
  { id: 'f-close', name: 'Close date', type: 'date' },
  {
    id: 'f-stage',
    name: 'Stage',
    type: 'choice',
    options: [
      { id: 'o-new', name: 'New', color: 'blue' },
      { id: 'o-won', name: 'Won', color: 'green' },
      { id: 'o-old', name: 'Old', color: 'gray', archived: true },
    ],
  },
  { id: 'f-rep', name: 'Reps', type: 'person', many: true },
  { id: 'f-client', name: 'Client', type: 'link', linkTo: 'board', board: '11111111-1111-4111-8111-111111111111' },
]
const board = (): BoardData => ({ ...exampleData('b1'), fields: FIELDS })
const OTHER = '11111111-1111-4111-8111-111111111111'
const look = (more: Partial<ImportLookups> = {}): ImportLookups => ({
  people: [
    { id: 'mai', name: 'Mai', email: 'mai@example.com' },
    { id: 'ploy', name: 'Ploy', email: 'ploy@example.com' },
    { id: 'non', name: 'Non' },
  ],
  linked: new Map([
    [
      'f-client',
      new Map([
        ['acme', [linkRef(OTHER, 'c1')]],
        ['twin co', [linkRef(OTHER, 'c2'), linkRef(OTHER, 'c3')]],
      ]),
    ],
  ]),
  canAddOption: () => true,
  ...more,
})
const plan = (sheet: string, more: Partial<ImportOptions> = {}, data = board(), lookups = look()) => {
  const { rows } = parseSheet(sheet)
  let n = 0
  const roles = more.roles ?? guessColumns(rows[0], data.fields)
  return { data, ...planCardImport(data, rows, { roles, header: true, zone: 'Asia/Bangkok', now: NOW, newId: () => `n${++n}`, ...more }, lookups) }
}
/** Runs the plan's command on the board. */
const run = (p: ReturnType<typeof plan>) => {
  const r = execute(p.data, p.command, { now: NOW, newId: () => 'x', idx: indexFor(p.data) })
  if ('error' in r) throw new Error(r.error)
  return { data: applyChanges(p.data, r.changes), changes: r.changes }
}
const tsv = (...lines: string[][]) => lines.map((l) => l.join('\t')).join('\n')

describe('what each column is', () => {
  it('is read from its name: the board’s own fields first, then what every card has, English or Thai', () => {
    expect(guessColumns(['Task', 'Notes', 'Status', 'Deadline', 'Start date', 'Tags', 'Owner', 'Priority', 'Parent', 'Whatever', ''], [])).toEqual([
      'title',
      'description',
      'list',
      'due',
      'start',
      'labels',
      'assignee',
      'priority',
      'parent',
      'skip',
      'skip',
    ])
    expect(guessColumns(['ชื่องาน', 'รายละเอียด', 'สถานะ', 'กำหนดส่ง', 'ผู้รับผิดชอบ'], [])).toEqual([
      'title',
      'description',
      'list',
      'due',
      'assignee',
    ])
    // "Stage" is the board's field when it has one, a list otherwise.
    expect(guessColumns(['Name', 'stage', 'EMAIL', 'Value'], FIELDS)).toEqual(['title', 'f:f-stage', 'f:f-email', 'f:f-value'])
    expect(guessColumns(['Name', 'Stage'], [])).toEqual(['title', 'list'])
  })

  it('each thing is used once; with no title in the names, the first free column is it', () => {
    expect(guessColumns(['Title', 'Name', 'Email', 'Email'], FIELDS)).toEqual(['title', 'skip', 'f:f-email', 'skip'])
    expect(guessColumns(['Company', 'Email', 'Phone'], FIELDS)).toEqual(['title', 'f:f-email', 'skip'])
    expect(guessColumns(['Email'], FIELDS)).toEqual(['f:f-email'])
  })
})

describe('rows as cards', () => {
  it('a contact list fills a board with nothing to set up', () => {
    const p = plan(tsv(['Name', 'Email', 'Value'], ['Acme Co', 'hi@acme.test', '1,200'], ['Bolt Ltd', 'bolt@bolt.test', '']))
    expect(p.report).toMatchObject({ cards: 2, subtasks: 0, lists: [], labels: [], noTitle: [], duplicates: [], problems: [] })
    expect(p.command.cards.map((c) => c.fields)).toEqual([
      { title: 'Acme Co', custom: { 'f-email': 'hi@acme.test', 'f-value': 1200 } },
      { title: 'Bolt Ltd', custom: { 'f-email': 'bolt@bolt.test' } },
    ])
    expect(CommandSchema.safeParse(p.command).success).toBe(true)
    const { data } = run(p)
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    const made = p.command.cards.map((c) => data.tasks[c.id])
    // In the first list for work that hasn't started, at the end of the outline, in the sheet's order.
    expect(made.map((t) => t.status)).toEqual(['todo', 'todo'])
    const roots = indexFor(data).roots
    expect(roots.slice(-2)).toEqual(made.map((t) => t.id))
  })

  it('everything a card has: list, dates, labels, assignee, priority, description', () => {
    const p = plan(
      tsv(
        ['Title', 'Description', 'List', 'Due', 'Start', 'Labels', 'Assignee', 'Priority'],
        ['Ship it', 'Line one', 'doing', '31/10/2026 14:30', '2026-10-01', 'Marketing, Fresh; brand', 'mai@example.com', 'High'],
        ['Plan it', '', 'Waiting on client', '15 ต.ค. 2569', '', 'fresh', 'ploy', 'p3'],
      ),
    )
    expect(p.report).toMatchObject({ cards: 2, lists: ['Waiting on client'], labels: ['Fresh'], problems: [] })
    const [ship, planIt] = p.command.cards.map((c) => c.fields)
    expect(ship).toMatchObject({
      description: 'Line one',
      status: 'doing',
      // 14:30 in Bangkok.
      due: '2026-10-31T07:30:00Z',
      start: '2026-10-01',
      assigneeId: 'mai',
      priority: 'high',
    })
    expect(ship.labels).toEqual(['marketing', p.command.labels![0].id, 'brand'])
    expect(planIt).toMatchObject({
      status: p.command.lists![0].id,
      due: '2026-10-15',
      labels: [p.command.labels![0].id],
      assigneeId: 'ploy',
      priority: 'low',
    })
    const { data } = run(p)
    expect(data.columns.at(-1)).toMatchObject({ name: 'Waiting on client', category: 'todo' })
    expect(data.labels.at(-1)).toMatchObject({ name: 'Fresh' })
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
  })

  it('a new list counts as what its name says', () => {
    const p = plan(tsv(['Title', 'List'], ['a', 'Shipped'], ['b', 'In review'], ['c', 'Ideas'], ['d', 'Parked']))
    expect(p.command.lists!.map((l) => [l.name, l.category])).toEqual([
      ['Shipped', 'done'],
      ['In review', 'doing'],
      ['Ideas', 'backlog'],
      ['Parked', 'todo'],
    ])
    // A card that arrives in a done list is done from then.
    const { data } = run(p)
    expect(data.tasks[p.command.cards[0].id].doneAt).toBe(NOW)
  })

  it('rows without a title are left out and counted; empty rows are nothing', () => {
    const p = plan(tsv(['Title', 'Email'], ['', 'lost@x.test'], ['', ''], ['Kept', '']))
    expect(p.report).toMatchObject({ cards: 1, noTitle: [2] })
  })

  it('a row whose title is already a card is left out, unless it’s wanted anyway', () => {
    const sheet = tsv(['Title'], ['  logo DESIGN '], ['Brand new'], ['Brand new'])
    const data = board()
    const logo = Object.values(data.tasks).find((t) => /logo/i.test(t.title))!
    const titled = sheet.replace('logo DESIGN', logo.title.toUpperCase())
    const p = plan(titled, {}, data)
    expect(p.report).toMatchObject({ cards: 2, duplicates: [2] })
    // (Two rows of the sheet with one title are both added: only the board is looked at.)
    expect(plan(titled, { addAnyway: true }, data).report).toMatchObject({ cards: 3, duplicates: [] })
  })

  it('cells that can’t be read are flagged by column, and their cards still added', () => {
    const p = plan(
      tsv(
        ['Title', 'Due', 'Value', 'Signed', 'Assignee', 'Priority', 'Stage', 'Reps', 'Client'],
        ['One', 'soon', 'lots', 'perhaps', 'Nobody', 'whenever', 'Old', 'Mai, Ghost', 'Nobody Inc'],
        ['Two', '2026-10-15', '5', 'yes', 'Non', 'urgent', 'won', 'mai; Ploy', 'ACME'],
        ['Three', 'tbd', '', '', '', '', '', '', 'Twin Co'],
      ),
      {},
      board(),
      look({ canAddOption: () => false }),
    )
    expect(p.report.cards).toBe(3)
    expect(p.report.problems.map((x) => [x.column, x.kind, x.rows, x.samples])).toEqual([
      ['Due', 'date', [2, 4], ['soon', 'tbd']],
      ['Value', 'number', [2], ['lots']],
      ['Signed', 'yes', [2], ['perhaps']],
      ['Assignee', 'person', [2], ['Nobody']],
      ['Priority', 'priority', [2], ['whenever']],
      ['Stage', 'option', [2], ['Old']],
      ['Reps', 'person', [2], ['Mai, Ghost']],
      ['Client', 'link', [2, 4], ['Nobody Inc', 'Twin Co']],
    ])
    expect(p.command.cards.map((c) => c.fields)).toEqual([
      { title: 'One', custom: { 'f-rep': ['mai'] } },
      {
        title: 'Two',
        due: '2026-10-15',
        assigneeId: 'non',
        priority: 'urgent',
        custom: { 'f-value': 5, 'f-signed': true, 'f-stage': ['o-won'], 'f-rep': ['mai', 'ploy'], 'f-client': [linkRef(OTHER, 'c1')] },
      },
      { title: 'Three' },
    ])
    expect(problemText(p.report.problems[0])).toBe('Due: 2 dates couldn’t be read')
    expect(problemText(p.report.problems[3])).toBe('Assignee: 1 name isn’t someone on this board')
    expect(rowsText([2, 4])).toBe('rows 2 and 4')
    expect(rowsText([7])).toBe('row 7')
    expect(rowsText([1, 2, 3, 4, 5, 6, 7])).toBe('rows 1, 2, 3, 4, 5 and 2 more')
  })

  it('a new option is made only for someone who manages the field, once per name', () => {
    const sheet = tsv(['Title', 'Stage'], ['a', 'Negotiating'], ['b', 'negotiating'], ['c', 'New'])
    const p = plan(sheet)
    expect(p.report.options).toEqual([{ field: 'Stage', names: ['Negotiating'] }])
    expect(p.options).toEqual([{ fieldId: 'f-stage', add: [{ id: expect.any(String), name: 'Negotiating', color: expect.any(String) }] }])
    const id = p.options[0].add[0].id
    expect(p.command.cards.map((c) => c.fields.custom)).toEqual([{ 'f-stage': [id] }, { 'f-stage': [id] }, { 'f-stage': ['o-new'] }])
    const no = plan(sheet, {}, board(), look({ canAddOption: () => false }))
    expect(no.options).toEqual([])
    expect(no.report.problems).toMatchObject([{ column: 'Stage', kind: 'option', rows: [2, 3] }])
  })

  it('two people of one name aren’t guessed between; an address settles it', () => {
    const two = look({
      people: [
        { id: 'a1', name: 'Ann', email: 'ann@one.test' },
        { id: 'a2', name: 'ann', email: 'ann@two.test' },
      ],
    })
    const p = plan(tsv(['Title', 'Assignee'], ['x', 'Ann'], ['y', 'ANN@two.test']), {}, board(), two)
    expect(p.command.cards.map((c) => c.fields.assigneeId)).toEqual([undefined, 'a2'])
    expect(p.report.problems).toMatchObject([{ kind: 'person', rows: [2] }])
  })
})

describe('dates that could be read two ways', () => {
  it('a column settles itself when one of its dates only works one way', () => {
    const p = plan(tsv(['Title', 'Due', 'Start'], ['a', '3/4/2026', '4/3/2026'], ['b', '25/12/2026', '12/25/2026']))
    expect(p.report.askDateOrder).toBeUndefined()
    expect(p.command.cards.map((c) => [c.fields.due, c.fields.start])).toEqual([
      ['2026-04-03', '2026-04-03'],
      ['2026-12-25', '2026-12-25'],
    ])
  })

  it('when nothing decides, it’s asked once, and the answer is used for every such column', () => {
    const sheet = tsv(['Title', 'Due', 'Close date'], ['a', '3/4/2026', '5/6/2026'], ['b', '2026-10-15', ''])
    const asked = plan(sheet)
    expect(asked.report.askDateOrder).toEqual({ column: 'Due', sample: '3/4/2026' })
    // Until it's said, those dates aren't read (and are flagged).
    expect(asked.command.cards[0].fields.due).toBeUndefined()
    const dmy = plan(sheet, { dateOrder: 'dmy' })
    expect(dmy.report.askDateOrder).toBeUndefined()
    expect(dmy.report.problems).toEqual([])
    expect(dmy.command.cards[0].fields).toMatchObject({ due: '2026-04-03', custom: { 'f-close': '2026-06-05' } })
    expect(plan(sheet, { dateOrder: 'mdy' }).command.cards[0].fields).toMatchObject({ due: '2026-03-04', custom: { 'f-close': '2026-05-06' } })
  })

  it('a column that disagrees with itself reads what it can and flags the rest', () => {
    const p = plan(tsv(['Title', 'Due'], ['a', '25/12/2026'], ['b', '12/25/2026'], ['c', '3/4/2026']), { dateOrder: 'dmy' })
    expect(p.command.cards.map((c) => c.fields.due)).toEqual(['2026-12-25', '2026-12-25', undefined])
    expect(p.report.problems).toMatchObject([{ kind: 'date', rows: [4] }])
  })
})

describe('cards under other cards', () => {
  it('a parent is a row of the sheet or a card on the board, whichever order the rows come in', () => {
    const data = board()
    const onBoard = Object.values(data.tasks).find((t) => !t.parentId)!
    const p = plan(
      tsv(['Title', 'Parent'], ['Child', 'Mother'], ['Mother', ''], ['Grandchild', 'child'], ['Under the board', onBoard.title]),
      {},
      data,
    )
    expect(p.report).toMatchObject({ cards: 4, subtasks: 3, problems: [] })
    const id = (title: string) => p.command.cards.find((c) => c.fields.title === title)!.id
    // Parents come before their subtasks in the command.
    expect(p.command.cards.map((c) => c.fields.title)).toEqual(['Mother', 'Child', 'Grandchild', 'Under the board'])
    expect(p.command.cards.map((c) => c.parentId)).toEqual([null, id('Mother'), id('Child'), onBoard.id])
    const { data: after } = run(p)
    const idx = indexFor(after)
    expect(idx.childrenOf.get(id('Mother'))).toEqual([id('Child')])
    // After the subtasks it already had.
    expect(idx.childrenOf.get(onBoard.id)!.at(-1)).toBe(id('Under the board'))
  })

  it('a parent that can’t be told is flagged, and the card goes to the top', () => {
    const p = plan(
      tsv(
        ['Title', 'Parent'],
        ['Twin', ''],
        ['Twin', ''],
        ['a', 'Twin'],
        ['b', 'Nobody'],
        ['Loop one', 'Loop two'],
        ['Loop two', 'Loop one'],
        ['Self', 'Self'],
      ),
    )
    expect(p.report.cards).toBe(7)
    expect(p.report.problems).toMatchObject([{ column: 'Parent', kind: 'parent', rows: [4, 5, 8, 7] }])
    const parent = (title: string) => p.command.cards.find((c) => c.fields.title === title)!.parentId
    expect([parent('a'), parent('b'), parent('Self')]).toEqual([null, null, null])
    // A loop is cut in one place: the other card keeps its parent.
    expect([parent('Loop one'), parent('Loop two')].filter(Boolean)).toHaveLength(1)
    expect(() => run(p)).not.toThrow()
  })
})

describe('saying what the columns are', () => {
  it('needs a title, each thing once, and fields the board has', () => {
    const sheet = tsv(['a', 'b'], ['1', '2'])
    const roles = (r: ColumnRole[]) => () => plan(sheet, { roles: r })
    expect(roles(['skip', 'description'])).toThrow(/which column is the title/)
    expect(roles(['title', 'title'])).toThrow(/only be used once/)
    expect(roles(['title', 'f:gone'])).toThrow(/no longer has/)
    expect(roles(['title'])().report.cards).toBe(1)
  })

  it('without a row of names, the first row is a card too', () => {
    const p = plan(tsv(['First', 'x@y.test'], ['Second', '']), { header: false, roles: ['title', 'f:f-email'] })
    expect(p.command.cards.map((c) => c.fields.title)).toEqual(['First', 'Second'])
    expect(plan(tsv(['First', 'oops'], ['Second', '']), { header: false, roles: ['title', 'f:f-value'] }).report.problems[0].column).toBe('Value')
  })

  it('more new lists than can be made at once are flagged, not made', () => {
    const lines = Array.from({ length: IMPORT_NEW_LISTS + 2 }, (_, i) => [`Card ${i}`, `List ${i}`])
    const p = plan(tsv(['Title', 'List'], ...lines))
    expect(p.command.lists).toHaveLength(IMPORT_NEW_LISTS)
    expect(p.report.problems).toMatchObject([{ kind: 'lists', rows: [IMPORT_NEW_LISTS + 2, IMPORT_NEW_LISTS + 3] }])
    expect(p.report.cards).toBe(IMPORT_NEW_LISTS + 2)
  })
})

describe('the command', () => {
  it('is one change: one line in the activity, and one undo takes it all back', () => {
    const p = plan(
      tsv(['Title', 'List', 'Labels', 'Parent'], ['Mother', 'Fresh list', 'Fresh', ''], ['Child', '', '', 'Mother'], ['Other', 'doing', '', '']),
    )
    const { data, changes } = run(p)
    expect(describeChanges(p.data, changes, p.command)).toEqual([{ text: 'imported 3 cards' }, { text: 'added the list “Fresh list”' }])
    const inverse = invertChanges(data, changes, NOW)
    const undone = execute(data, { type: 'records.restore', changes: inverse }, { now: NOW, newId: () => 'x', idx: indexFor(data) })
    if ('error' in undone) throw new Error(undone.error)
    const back = applyChanges(data, undone.changes)
    expect(Object.keys(back.tasks).sort()).toEqual(Object.keys(p.data.tasks).sort())
    expect(back.columns.map((c) => c.id)).toEqual(p.data.columns.map((c) => c.id))
    expect(back.labels.map((l) => l.id)).toEqual(p.data.labels.map((l) => l.id))
  })

  it('refuses what a board can’t hold: an id in use, a parent that isn’t there, a list or person that’s gone, too many', () => {
    const data = board()
    const some = Object.keys(data.tasks)[0]
    const refusal = (cmd: Parameters<typeof execute>[1]) => {
      const r = execute(data, cmd, { now: NOW, newId: () => 'x', idx: indexFor(data) })
      return 'error' in r ? r.error : null
    }
    const card = (id: string, more: object = {}) => ({ id, parentId: null, fields: { title: 'T' }, ...more })
    expect(refusal({ type: 'tasks.import', cards: [card(some)] })).toMatch(/already exists/)
    expect(refusal({ type: 'tasks.import', cards: [card('n1'), card('n1')] })).toMatch(/already exists/)
    expect(refusal({ type: 'tasks.import', cards: [card('n1', { parentId: 'n2' }), card('n2')] })).toMatch(/parent task/)
    expect(refusal({ type: 'tasks.import', cards: [card('n1', { fields: { title: 'T', status: 'nope' } })] })).toMatch(/list no longer exists/)
    expect(refusal({ type: 'tasks.import', cards: [card('n1', { fields: { title: 'T', assigneeId: 'ghost' } })] })).toMatch(/no longer on this board/)
    expect(refusal({ type: 'tasks.import', cards: [card('n1', { fields: { title: '  ' } })] })).toMatch(/needs a title/)
    expect(refusal({ type: 'tasks.import', lists: [{ id: 'todo', name: 'Again', category: 'todo' }], cards: [] })).toMatch(/already exists/)
    const many = Array.from({ length: IMPORT_MAX + 1 }, (_, i) => card(`n${i}`))
    expect(refusal({ type: 'tasks.import', cards: many })).toMatch(/at most/)
    expect(CommandSchema.safeParse({ type: 'tasks.import', cards: many }).success).toBe(false)
    expect(refusal({ type: 'tasks.import', cards: [] })).toBeNull()
  })

  it('2,000 rows are planned and added quickly', () => {
    const lines = Array.from({ length: IMPORT_MAX }, (_, i) => [
      `Card ${i}`,
      `Notes for card ${i}`,
      ['todo', 'doing', 'done', 'Review'][i % 4],
      `${(i % 28) + 1}/10/2026`,
      i % 3 ? 'Marketing' : 'brand, Fresh',
      i % 2 ? 'Mai' : 'ploy@example.com',
      String(i * 10),
      i % 50 === 0 ? '' : `Card ${i - (i % 50)}`,
    ])
    const sheet = tsv(['Title', 'Description', 'List', 'Due', 'Labels', 'Assignee', 'Value', 'Parent'], ...lines)
    const started = performance.now()
    const p = plan(sheet)
    const planned = performance.now()
    const { data } = run(p)
    const done = performance.now()
    expect(p.report).toMatchObject({ cards: IMPORT_MAX, subtasks: IMPORT_MAX - IMPORT_MAX / 50, problems: [] })
    expect(Object.keys(data.tasks)).toHaveLength(Object.keys(p.data.tasks).length + IMPORT_MAX)
    // (Generous: a slow machine running everything at once still passes, a quadratic slip doesn't.)
    expect(planned - started).toBeLessThan(1500)
    expect(done - planned).toBeLessThan(1500)
  })
})
