import { describe, expect, it } from 'vitest'
import { parseBoard } from './transfer'
import { indexFor } from './indexer'
import { repairData, upgradeSave } from './migrate'
import { exampleData } from './sample'
import { BoardDataSchema } from './schema'

const NOW = '2026-05-01T10:00:00.000Z'
let n = 0
const u = { now: NOW, newId: () => `id-${++n}` }

/** A v1 (prototype) save: numeric positions, people and labels as names. */
const v1 = {
  mode: 'manual',
  tasks: {
    p: { id: 'p', title: 'Project', parentId: null, status: 'doing', order: 1, labels: [], blockedBy: [] },
    b: { id: 'b', title: 'Second', parentId: 'p', status: 'todo', order: 2, assignee: 'Mai', labels: ['ui'], blockedBy: [], rank: 2 },
    a: { id: 'a', title: 'First', parentId: 'p', status: 'todo', order: 1, assignee: 'mai', labels: ['UI', 'brand'], blockedBy: ['ghost'], rank: 1 },
  },
  config: { layout: 'board', columns: 'status', rows: 'none', filter: 'all', parentDisplay: 'label' },
}

describe('upgrading old saves', () => {
  it('a prototype save becomes valid board data, keeping order and turning names into records', () => {
    const up = upgradeSave(v1, u)!
    expect(BoardDataSchema.safeParse(up.data).success).toBe(true)
    const { data } = up
    expect(data.board.mode).toBe('manual')
    // "Mai" and "mai" are one person; "ui" and "UI" one label.
    expect(data.members.map((m) => m.name)).toEqual(['Mai'])
    expect(data.labels.map((l) => l.name).sort()).toEqual(['brand', 'ui'])
    expect(data.tasks.a.assigneeId).toBe(data.members[0].id)
    // Sibling order and board order survive the switch to position keys.
    expect(indexFor(data).childrenOf.get('p')).toEqual(['a', 'b'])
    expect(data.tasks.a.rank! < data.tasks.b.rank!).toBe(true)
    // Links to things that don't exist are dropped.
    expect(data.tasks.a.blockedBy).toEqual([])
    // An old single "parent display" setting becomes a list.
    expect(up.prefs.display?.board.parentDisplay).toEqual(['label'])
  })

  it('a v2 save: the List tab opens as Outline, filters and rows by person point at member ids', () => {
    const v2 = {
      version: 2,
      boardName: 'Team',
      background: 'teal',
      tasks: v1.tasks,
      columns: [
        { id: 'todo', name: 'To Do', category: 'todo' },
        { id: 'doing', name: 'Doing', category: 'doing' },
      ],
      labels: [{ id: 'ui', name: 'ui', color: 'blue' }],
      layout: 'list',
      filter: { assignees: ['Mai', ''] },
      collapsedRows: ['Mai'],
    }
    const { data, prefs } = upgradeSave(v2, u)!
    const mai = data.members[0].id
    expect(data.board).toMatchObject({ name: 'Team', background: 'teal' })
    expect(data.columns.map((c) => c.id)).toEqual(['todo', 'doing'])
    expect(data.tasks.a.labels).toContain('ui') // existing label ids are kept
    expect(prefs.layout).toBe('outline')
    expect(prefs.filter?.assignees).toEqual([mai, ''])
    expect(prefs.collapsedRows).toEqual([mai])
  })

  it('rejects things that aren’t boards', () => {
    expect(upgradeSave(null, u)).toBeNull()
    expect(upgradeSave({ tasks: { x: { nope: true } } }, u)).toBeNull()
  })

  it('repair drops references to missing parents, lists, people and labels', () => {
    const d = exampleData('b')
    d.tasks.A3 = { ...d.tasks.A3, parentId: 'ghost', status: 'ghost', assigneeId: 'ghost', labels: ['ghost'] }
    const r = repairData(d).tasks.A3
    expect(r).toMatchObject({ parentId: null, status: 'todo', labels: [] })
    expect(r.assigneeId).toBeUndefined()
  })
})

describe('import', () => {
  it('round-trips the current export format and takes over the current board id', () => {
    const file = JSON.stringify({ app: 'kanbanto', format: 3, data: exampleData('other') })
    const data = parseBoard(file, 'mine')
    expect(data.board.id).toBe('mine')
    expect(Object.keys(data.tasks)).toHaveLength(Object.keys(exampleData('x').tasks).length)
  })

  it('refuses damaged current-format files and non-boards with a readable reason', () => {
    const damaged = exampleData('x') as unknown as { tasks: Record<string, unknown> }
    damaged.tasks.A1 = { title: 'no id' }
    expect(() => parseBoard(JSON.stringify({ app: 'kanbanto', format: 3, data: damaged }), 'b')).toThrow(/damaged/)
    expect(() => parseBoard('{nope', 'b')).toThrow(/JSON/)
    expect(() => parseBoard('{"hello": 1}', 'b')).toThrow(/isn’t a board/)
  })

  it('accepts older exports (a bare task list) and converts them', () => {
    const data = parseBoard(JSON.stringify(Object.values(v1.tasks)), 'b')
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    expect(data.members.map((m) => m.name)).toEqual(['Mai'])
  })
})

describe('files that didn’t come from an export', () => {
  it('an old-format file passes the same checks as a new one, and parent loops are cut', async () => {
    const { readBoardFile } = await import('./transfer')
    expect(() => readBoardFile({ boardName: 'x', tasks: [{ id: 'a', title: 't', due: 'not-a-date' }] }, 'b')).toThrow(/damaged/)
    expect(() => readBoardFile({ boardName: 'x', tasks: [{ id: 'a', title: 'T'.repeat(600) }] }, 'b')).toThrow(/damaged/)
    const ok = readBoardFile(
      {
        boardName: 'x',
        tasks: [
          { id: 'a', title: 'A', parentId: 'b' },
          { id: 'b', title: 'B', parentId: 'a' },
        ],
      },
      'b',
    )
    expect(Object.values(ok.tasks).filter((t) => t.parentId).length).toBe(1)
  })
})
