import { describe, expect, it } from 'vitest'
import { cardsCsv, cardsSheet, sheetDate, toCsv } from './exportSheet'
import { linkRef, type BoardField } from './fields'
import { guessColumns, planCardImport } from './importCards'
import { indexFor } from './indexer'
import { emptyBoard, exampleData } from './sample'
import { parseSheet } from './sheet'
import type { BoardData } from './types'

const ZONE = 'Asia/Bangkok'
const B = '22222222-2222-4222-8222-222222222222'
const OTHER = '11111111-1111-4111-8111-111111111111'
const FIELDS: BoardField[] = [
  { id: 'f-client', name: 'Client', type: 'text' },
  { id: 'f-value', name: 'Value', type: 'number', unit: '฿', decimals: 2 },
  { id: 'f-paid', name: 'Paid', type: 'checkbox' },
  { id: 'f-close', name: 'Close date', type: 'date' },
  {
    id: 'f-stage',
    name: 'Stage',
    type: 'choice',
    options: [
      { id: 'o-new', name: 'New', color: 'blue' },
      { id: 'o-won', name: 'Won', color: 'green' },
    ],
  },
  { id: 'f-rep', name: 'Reps', type: 'person', many: true },
  { id: 'f-after', name: 'Comes after', type: 'link', linkTo: 'board', board: B },
]
/** The example board (Mai, Ton and Ploy on it) with fields of every kind, and values on Deploy (A3). */
function board(): BoardData {
  const data = { ...exampleData(B), fields: FIELDS }
  data.board = { ...data.board, code: 'WEB' }
  let n = 0
  data.tasks = Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, { ...t, number: ++n }]))
  data.tasks.A3 = {
    ...data.tasks.A3,
    title: 'Deploy, then "announce"',
    description: 'Two lines:\n- one\n- two',
    priority: 'high',
    start: '2026-10-12',
    due: '2026-10-15T07:30:00.000Z',
    labels: ['ui', 'brand'],
    custom: {
      'f-client': 'Acme, Inc.',
      'f-value': 12000.5,
      'f-paid': true,
      'f-close': '2026-11-01',
      'f-stage': ['o-won'],
      'f-rep': ['ton', 'ploy'],
      'f-after': [linkRef(B, 'A2a'), linkRef(OTHER, 'x')],
    },
  }
  return data
}
const row = (rows: string[][], title: string) => Object.fromEntries(rows[0].map((name, i) => [name, rows.find((r) => r[1] === title)![i]]))

describe('a board as a spreadsheet', () => {
  it('has one row for a card, under names the import reads, each cell written the way it reads them', () => {
    const data = board()
    const idx = indexFor(data)
    const rows = cardsSheet(data, idx.preorder, {
      zone: ZONE,
      minutes: { A3: 90, A1: 20 },
      titleOf: (ref) => (ref === linkRef(OTHER, 'x') ? 'Elsewhere' : undefined),
    })
    expect(rows).toHaveLength(idx.preorder.length + 1)
    expect(rows[0]).toEqual([
      'Card number',
      'Title',
      'Parent',
      'List',
      'Assignee',
      'Priority',
      'Start',
      'Due',
      'Labels',
      'Client',
      'Value',
      'Paid',
      'Close date',
      'Stage',
      'Reps',
      'Comes after',
      'Description',
      'Time logged (hours)',
      'Created',
      'Updated',
      'Done on',
    ])
    expect(row(rows, 'Deploy, then "announce"')).toMatchObject({
      'Card number': `WEB-${data.tasks.A3.number}`,
      Parent: 'Launch website',
      List: 'To Do',
      Assignee: 'Mai',
      Priority: 'High',
      Start: '2026-10-12',
      // (A moment is written by the clock of the person saving the file: 07:30 UTC is 14:30 in Bangkok.)
      Due: '2026-10-15 14:30',
      Labels: 'ui, brand',
      Client: 'Acme, Inc.',
      Value: '12000.5',
      Paid: 'Yes',
      'Close date': '2026-11-01',
      Stage: 'Won',
      Reps: 'Ton, Ploy',
      'Comes after': 'Homepage, Elsewhere',
      Description: 'Two lines:\n- one\n- two',
      'Time logged (hours)': '1.5',
      'Done on': '',
    })
    // A parent shows in the list the board gives it; a card nobody logged time on has none; a done card says when.
    expect(row(rows, 'Launch website')).toMatchObject({ Parent: '', List: 'Doing', 'Time logged (hours)': '' })
    expect(row(rows, 'Buy domain')).toMatchObject({ List: 'Done', 'Time logged (hours)': '0.33' })
    expect(row(rows, 'Buy domain')['Done on']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/)
    // In the order given, and only the cards asked for. Without minutes, no column for them.
    const few = cardsSheet(data, ['B1', 'A3', 'nope'], { zone: ZONE })
    expect(few.slice(1).map((r) => r[1])).toEqual(['Send invites', 'Deploy, then "announce"'])
    expect(few[0]).not.toContain('Time logged (hours)')
  })

  it('has archived cards when asked for, with the list each was in and when it was put away', () => {
    const data = board()
    const { A1, ...rest } = data.tasks
    const whole: BoardData = {
      ...data,
      tasks: rest,
      archived: {
        A1: { ...A1, archivedAt: '2026-10-07T03:00:00.000Z', archivedList: 'Shipped', archivedDone: true, doneAt: '2026-10-05T02:00:00.000Z' },
      },
    }
    const rows = cardsSheet(whole, ['A3', 'A1'], { zone: ZONE })
    expect(rows[0].at(-1)).toBe('Archived')
    expect(row(rows, 'Buy domain')).toMatchObject({
      List: 'Shipped',
      'Done on': '2026-10-05 09:00',
      Archived: '2026-10-07 10:00',
      Parent: 'Launch website',
    })
    expect(row(rows, 'Deploy, then "announce"').Archived).toBe('')
    // No archived card among them: no column.
    expect(cardsSheet(whole, ['A3'], { zone: ZONE })[0]).not.toContain('Archived')
  })

  it('is a .csv Excel reads: quoted where it must be, and what people typed can’t act as a formula', () => {
    const csv = toCsv(
      [
        ['Title', 'Value'],
        ['Plain', '12'],
        ['Has, a comma', '-5'],
        ['Says "hi"', ''],
        ['Two\nlines', '=1+1'],
        ['=HYPERLINK("http://x","click")', '+3'],
        ['-dash', '@x'],
      ],
      (column) => column === 'Title',
    )
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Title,Value',
      'Plain,12',
      '"Has, a comma",-5',
      '"Says ""hi""",',
      '"Two\nlines",=1+1',
      // (Only the columns of typed text are guarded: a number may start with a minus.)
      '"\'=HYPERLINK(""http://x"",""click"")",+3',
      "'-dash,@x",
      '',
    ])
    // Read back, the apostrophe is the mark and not part of the text.
    expect(parseSheet(csv).rows.map((r) => r[0])).toEqual([
      'Title',
      'Plain',
      'Has, a comma',
      'Says "hi"',
      'Two\nlines',
      '=HYPERLINK("http://x","click")',
      '-dash',
    ])
    expect(sheetDate(undefined, ZONE)).toBe('')
    expect(sheetDate('2026-10-15', ZONE)).toBe('2026-10-15')
    expect(sheetDate('2026-10-15T20:30:00.000Z', ZONE)).toBe('2026-10-16 03:30')
    // A board's own text fields are guarded too; its numbers aren't.
    const data = board()
    data.tasks.A3 = { ...data.tasks.A3, title: '+1 on this', custom: { 'f-client': '=cmd', 'f-value': -4 } }
    const line = cardsCsv(data, ['A3'], { zone: ZONE }).split('\r\n')[1]
    expect(line).toContain(",'+1 on this,")
    expect(line).toContain(",'=cmd,-4,")
    // A column's name is typed too (a field's): the first row is guarded whatever the column holds.
    const named = toCsv(
      [
        ['Title', '=HYPERLINK("http://x","Due")'],
        ['a', '5'],
      ],
      (column) => column === 'Title',
    )
    expect(named.slice(1).split('\r\n')[0]).toBe('Title,"\'=HYPERLINK(""http://x"",""Due"")"')
    expect(parseSheet(named).rows[0]).toEqual(['Title', '=HYPERLINK("http://x","Due")'])
  })

  it('comes back through the import as the same cards', () => {
    const data = board()
    // (A link to a card of another board is left out of this round trip: its title isn't known to the new board.)
    data.tasks.A3 = { ...data.tasks.A3, custom: { ...data.tasks.A3.custom, 'f-after': [linkRef(B, 'A2a')] } }
    const idx = indexFor(data)
    const sheet = parseSheet(cardsCsv(data, idx.preorder, { zone: ZONE, minutes: { A3: 90 } }))
    // Into an empty board with the same fields, lists and people.
    const fresh: BoardData = { ...emptyBoard('b2', 'Copy', '2026-10-08T00:00:00.000Z'), fields: FIELDS, members: data.members, columns: data.columns }
    const roles = guessColumns(sheet.rows[0], fresh.fields)
    expect(roles).toEqual([
      'skip',
      'title',
      'parent',
      'list',
      'assignee',
      'priority',
      'start',
      'due',
      'labels',
      'f:f-client',
      'f:f-value',
      'f:f-paid',
      'f:f-close',
      'f:f-stage',
      'f:f-rep',
      'f:f-after',
      'description',
      'skip',
      'skip',
      'skip',
      'skip',
    ])
    let n = 0
    const plan = planCardImport(
      fresh,
      sheet.rows,
      { roles, header: true, zone: ZONE, now: '2026-10-08T00:00:00.000Z', newId: () => `n${++n}` },
      { people: data.members.map((m) => ({ id: m.id, name: m.name })), canAddOption: () => false },
    )
    expect(plan.report).toMatchObject({ cards: idx.preorder.length, noTitle: [], duplicates: [] })
    // (The one thing a new board can't know: a card link's target is found by title among cards that exist there.)
    expect(plan.report.problems).toMatchObject([{ column: 'Comes after', kind: 'link', samples: ['Homepage'] }])
    const cards = plan.command.cards
    const byTitle = new Map(cards.map((c) => [c.fields.title, c]))
    const back = byTitle.get('Deploy, then "announce"')!
    const labelName = new Map((plan.command.labels ?? []).map((l) => [l.id, l.name]))
    expect(back.fields).toMatchObject({
      status: 'todo',
      assigneeId: 'mai',
      priority: 'high',
      start: '2026-10-12',
      due: '2026-10-15T07:30:00Z',
      description: 'Two lines:\n- one\n- two',
      custom: {
        'f-client': 'Acme, Inc.',
        'f-value': 12000.5,
        'f-paid': true,
        'f-close': '2026-11-01',
        'f-stage': ['o-won'],
        'f-rep': ['ton', 'ploy'],
      },
    })
    expect(back.fields.labels!.map((id) => labelName.get(id))).toEqual(['ui', 'brand'])
    // Subtasks find their parents again, by title.
    expect(back.parentId).toBe(byTitle.get('Launch website')!.id)
    for (const id of idx.preorder) {
      const t = data.tasks[id]
      const parent = t.parentId ? data.tasks[t.parentId].title : null
      const got = byTitle.get(t.title)!
      expect(got.parentId ? cards.find((c) => c.id === got.parentId)!.fields.title : null).toBe(parent)
    }
  })
})
