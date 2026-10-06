import { describe, expect, it } from 'vitest'
import { applyChanges, invertChanges } from './changes'
import { describeChanges } from './activity'
import { execute, type Command } from './commands'
import { uuidv7 } from './ids'
import { indexFor } from './indexer'
import { comparePositions, positionBetween } from './position'
import { exampleData } from './sample'
import { BoardDataSchema, CommandSchema } from './schema'
import type { BoardData } from './types'
import { buildView, cellKey, NO_ROW } from './view'

const NOW = '2026-05-01T10:00:00.000Z'
let n = 0
const ctx = (data: BoardData) => ({ now: NOW, newId: () => `new-${++n}`, idx: indexFor(data) })

/** Runs a command; returns the new data and its changes, or throws with the refusal message. */
function exec(data: BoardData, cmd: Command) {
  const r = execute(data, cmd, ctx(data))
  if ('error' in r) throw new Error(r.error)
  return { data: applyChanges(data, r.changes), changes: r.changes }
}
const refusal = (data: BoardData, cmd: Command) => {
  const r = execute(data, cmd, ctx(data))
  return 'error' in r ? r.error : null
}
const board = () => exampleData('b1')

describe('ids and positions', () => {
  it('new ids are UUIDv7: unique, well-formed and sortable by time', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a < b).toBe(true)
    expect(new Set(Array.from({ length: 10_000 }, () => uuidv7())).size).toBe(10_000)
  })

  it('positions never run out: 200 inserts into the same gap stay distinct and ordered', () => {
    let hi = 'a1'
    const lo = 'a0'
    const keys: string[] = []
    for (let i = 0; i < 200; i++) keys.push((hi = positionBetween(lo, hi)))
    expect(new Set(keys).size).toBe(200)
    expect([...keys].sort(comparePositions)).toEqual([...keys].reverse())
  })
})

describe('task commands', () => {
  it('creates a task with defaults, a position after its siblings, and bookkeeping', () => {
    const { data, changes } = exec(board(), { type: 'task.create', id: 'T', parentId: 'A', fields: { title: '  Write docs ' } })
    const t = data.tasks.T
    expect(t).toMatchObject({ title: 'Write docs', parentId: 'A', status: 'todo', createdAt: NOW, updatedAt: NOW, version: 1 })
    expect(comparePositions(t.order, data.tasks.A4.order)).toBe(1)
    expect(changes).toHaveLength(1)
  })

  it('refuses tasks without a title, under a missing parent, or in a missing list', () => {
    expect(refusal(board(), { type: 'task.create', parentId: null, fields: { title: '  ' } })).toMatch(/title/)
    expect(refusal(board(), { type: 'task.create', parentId: 'nope', fields: { title: 'x' } })).toMatch(/parent/)
    expect(refusal(board(), { type: 'task.create', parentId: null, fields: { title: 'x', status: 'nope' } })).toMatch(/list/)
  })

  it('updates only allowed fields, tidies references, and bumps the version', () => {
    const before = board()
    const { data } = exec(before, {
      type: 'task.update',
      id: 'A3',
      fields: { title: 'Ship it', labels: ['ui', 'ui', 'ghost'], blockedBy: ['A3', 'A1', 'ghost'], due: '' },
    })
    const t = data.tasks.A3
    expect(t).toMatchObject({ title: 'Ship it', labels: ['ui'], blockedBy: ['A1'], version: before.tasks.A3.version + 1, updatedAt: NOW })
    expect(t.due).toBeUndefined()
    expect(t.createdAt).toBe(before.tasks.A3.createdAt)
    expect(refusal(before, { type: 'task.update', id: 'A3', fields: { due: '31/10/2026' } })).toMatch(/Dates/)
    expect(refusal(before, { type: 'task.update', id: 'A3', fields: { assigneeId: 'ghost' } })).toMatch(/person/)
  })

  it('a parent that follows its subtasks can’t have its status set; in manual mode it can', () => {
    expect(refusal(board(), { type: 'task.update', id: 'A2', fields: { status: 'done' } })).toMatch(/follows its subtasks/)
    const manual = exec(board(), { type: 'board.update', fields: { mode: 'manual' } }).data
    expect(exec(manual, { type: 'task.update', id: 'A2', fields: { status: 'done' } }).data.tasks.A2.status).toBe('done')
  })

  it('dates: a whole day, or a time sent with its time zone and stored in UTC', () => {
    const t = exec(board(), { type: 'task.update', id: 'A3', fields: { start: '2026-10-14', due: '2026-10-15T14:30:00+07:00' } }).data.tasks.A3
    expect([t.start, t.due]).toEqual(['2026-10-14', '2026-10-15T07:30:00Z'])
    expect(refusal(board(), { type: 'task.update', id: 'A3', fields: { due: '2026-10-15T14:30' } })).toMatch(/Dates look like/)
  })

  it('updating the board to what it already is changes nothing', () => {
    const b = board()
    expect(exec(b, { type: 'board.update', fields: { name: b.board.name, mode: b.board.mode } }).changes).toEqual([])
    expect(exec(b, { type: 'board.update', fields: { name: 'Renamed' } }).changes).toHaveLength(1)
  })

  it('moves: no loops; reparent and place before a sibling', () => {
    expect(refusal(board(), { type: 'task.move', id: 'A', parentId: 'A2a' })).toMatch(/own subtasks/)
    const { data } = exec(board(), { type: 'task.move', id: 'A3', parentId: 'B', place: { before: 'B1' } })
    expect(indexFor(data).childrenOf.get('B')).toEqual(['A3', 'B1', 'B2'])
  })

  it('reordering a board list: first time places the list, after that one write per move', () => {
    const view = (d: BoardData) => buildView(indexFor(d), { columns: 'status', rows: 'none', filter: 'leaves', parentDisplay: [] })
    const todo = (d: BoardData) => view(d).cells.get(cellKey(NO_ROW, 'todo'))!
    let data = board()
    expect(todo(data)).toEqual(['A2b', 'A3'])
    // Nothing placed by hand yet → the whole list gets positions once.
    let r = exec(data, { type: 'task.move', id: 'A3', list: ['A3', 'A2b'] })
    data = r.data
    expect(todo(data)).toEqual(['A3', 'A2b'])
    expect(r.changes.map((c) => c.id).sort()).toEqual(['A2b', 'A3'])
    // Now a move writes only the moved card.
    r = exec(data, { type: 'task.move', id: 'A2b', list: ['A2b', 'A3'] })
    expect(todo(r.data)).toEqual(['A2b', 'A3'])
    expect(r.changes.map((c) => c.id)).toEqual(['A2b'])
  })

  it('deleting a task deletes its subtasks and "waiting on" links to them', () => {
    let data = exec(board(), { type: 'task.update', id: 'B1', fields: { blockedBy: ['A2a'] } }).data
    data = exec(data, { type: 'task.delete', id: 'A2' }).data
    expect(data.tasks.A2 ?? data.tasks.A2a ?? data.tasks.A2b).toBeUndefined()
    expect(data.tasks.B1.blockedBy).toEqual([])
  })

  it('moves a parent’s subtasks together', () => {
    const { data } = exec(board(), { type: 'tasks.moveToList', ids: ['A2a', 'A2b'], status: 'done' })
    expect([data.tasks.A2a.status, data.tasks.A2b.status]).toEqual(['done', 'done'])
    expect(indexFor(data).status.get('A2')).toBe('done')
  })
})

describe('lists, labels, people, board', () => {
  it('deleting a list moves its cards; a board keeps at least one list', () => {
    const { data } = exec(board(), { type: 'column.delete', id: 'doing', moveTo: 'todo' })
    expect(data.columns.map((c) => c.id)).toEqual(['backlog', 'todo', 'done'])
    expect(data.tasks.A2a.status).toBe('todo')
    let one = data
    for (const id of ['backlog', 'done']) one = exec(one, { type: 'column.delete', id, moveTo: 'todo' }).data
    expect(refusal(one, { type: 'column.delete', id: 'todo', moveTo: 'todo' })).toMatch(/at least one list/)
  })

  it('moving a list rewrites only that list', () => {
    const { data, changes } = exec(board(), { type: 'column.move', id: 'done', beforeId: 'todo' })
    expect(data.columns.map((c) => c.id)).toEqual(['backlog', 'done', 'todo', 'doing'])
    expect(changes.map((c) => c.id)).toEqual(['done'])
  })

  it('deleting a label takes it off every card', () => {
    const { data } = exec(board(), { type: 'label.delete', id: 'marketing' })
    expect(Object.values(data.tasks).some((t) => t.labels.includes('marketing'))).toBe(false)
  })
})

describe('changing several tasks at once', () => {
  const manual = (): BoardData => ({ ...board(), board: { ...board().board, mode: 'manual' } })

  it('is one change: each task gets what was said for it, and one undo puts them all back', () => {
    const before = manual()
    // (Someone it isn't assigned to yet.)
    const who = before.tasks.B.assigneeId === 'ton' ? 'mai' : 'ton'
    const { data, changes } = exec(before, {
      type: 'tasks.update',
      cards: [
        { id: 'A1', fields: { status: 'doing', priority: 'high' } },
        { id: 'A3', fields: { status: 'doing', due: '2026-12-01', labels: ['ui', 'ui', 'nope'] } },
        { id: 'B', fields: { assigneeId: who } },
      ],
    })
    expect(changes.map((c) => c.id)).toEqual(['A1', 'A3', 'B'])
    expect(data.tasks.A1).toMatchObject({ status: 'doing', priority: 'high', version: before.tasks.A1.version + 1, activeAt: NOW })
    expect(data.tasks.A3).toMatchObject({ status: 'doing', due: '2026-12-01', labels: ['ui'] })
    expect(data.tasks.B.assigneeId).toBe(who)
    expect(describeChanges(before, changes).map((i) => i.text)).toEqual([
      'moved “Buy domain” to Doing',
      'set the priority of “Buy domain” to high',
      'moved “Deploy” to Doing',
      `set “Deploy” due 2026-12-01`,
      'changed the labels of “Deploy”',
      `assigned “${before.tasks.B.title}” to ${who === 'ton' ? 'Ton' : 'Mai'}`,
    ])
    const undone = exec(data, { type: 'records.restore', changes: invertChanges(data, changes, NOW) })
    expect(undone.data.tasks.A1.status).toBe(before.tasks.A1.status)
    expect(undone.data.tasks.A1.priority).toBeUndefined()
    expect(undone.data.tasks.A3.due).toBe(before.tasks.A3.due)
    expect(undone.data.tasks.B.assigneeId).toBe(before.tasks.B.assigneeId)
  })

  it('tasks moved into a list go where its new order says, without touching the cards that stay', () => {
    const before = manual()
    const view = (d: BoardData) => buildView(indexFor(d), { columns: 'status', rows: 'none', filter: 'all', parentDisplay: [] })
    const inDoing = (d: BoardData) => view(d).cells.get(cellKey(NO_ROW, 'doing')) ?? []
    const was = inDoing(before)
    const { data, changes } = exec(before, {
      type: 'tasks.update',
      cards: [
        { id: 'A1', fields: { status: 'doing' } },
        { id: 'A3', fields: { status: 'doing' } },
      ],
      lists: [{ status: 'doing', order: [...was, 'A3', 'A1'] }],
    })
    expect(inDoing(data)).toEqual([...was, 'A3', 'A1'])
    // Asked again, nothing changes: the same request twice is one change.
    const again = exec(data, {
      type: 'tasks.update',
      cards: [
        { id: 'A1', fields: { status: 'doing' } },
        { id: 'A3', fields: { status: 'doing' } },
      ],
    })
    expect(again.changes).toEqual([])
    expect(changes.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses the whole change when any part of it can’t be done', () => {
    const data = board()
    const cards = (more: object[]) => ({
      type: 'tasks.update' as const,
      cards: [{ id: 'A1', fields: { priority: 'low' as const } }, ...more] as never,
    })
    expect(refusal(data, cards([{ id: 'ghost', fields: { priority: 'low' } }]))).toMatch(/no longer exists/)
    expect(refusal(data, cards([{ id: 'A1', fields: { priority: 'high' } }]))).toMatch(/named twice/)
    expect(refusal(data, cards([{ id: 'A3', fields: { status: 'nope' } }]))).toMatch(/list no longer exists/)
    expect(refusal(data, cards([{ id: 'A3', fields: { assigneeId: 'ghost' } }]))).toMatch(/no longer on this board/)
    // Where a parent follows its subtasks, it can't be moved by hand, alone or among others.
    expect(refusal(data, cards([{ id: 'A', fields: { status: 'done' } }]))).toMatch(/follows its subtasks/)
    expect(refusal(data, { type: 'tasks.update', cards: [{ id: 'A1', fields: {} }], lists: [{ status: 'nope', order: [] }] })).toMatch(
      /list no longer exists/,
    )
    expect(CommandSchema.safeParse({ type: 'tasks.update', cards: [{ id: 'A1', fields: { priority: 'low' } }] }).success).toBe(true)
    expect(CommandSchema.safeParse({ type: 'tasks.update', cards: [{ id: 'A1', fields: { colour: 'red' } }], extra: 1 }).success).toBe(true)
    expect(CommandSchema.safeParse({ type: 'tasks.update', cards: [{ fields: {} }] }).success).toBe(false)
  })
})

describe('undo', () => {
  it('reverses a command as a new change, and redo reapplies it', () => {
    const start = board()
    const { data: after, changes } = exec(start, { type: 'task.delete', id: 'A2' })
    const undo = invertChanges(after, changes, NOW)
    const restored = applyChanges(after, undo)
    expect(Object.keys(restored.tasks).sort()).toEqual(Object.keys(start.tasks).sort())
    expect(restored.tasks.A2a.title).toBe('Homepage')
    // Restoring is itself a change, so the record's version goes up (a server sees a normal edit).
    expect(restored.tasks.A2a.version).toBe(start.tasks.A2a.version + 1)
    const redone = applyChanges(restored, invertChanges(restored, undo, NOW))
    expect(redone.tasks.A2).toBeUndefined()
  })

  it('undo is a command (records.restore), so a server can check it', () => {
    const start = board()
    const { data: after, changes } = exec(start, { type: 'task.delete', id: 'A2' })
    const { data: restored } = exec(after, { type: 'records.restore', changes: invertChanges(after, changes, NOW) })
    expect(Object.keys(restored.tasks).sort()).toEqual(Object.keys(start.tasks).sort())
    expect(restored.tasks.A2a.createdAt).toBe(start.tasks.A2a.createdAt)
    expect(restored.tasks.A2a.version).toBe(start.tasks.A2a.version + 1)
  })

  it('refuses to undo over someone else’s newer edit', () => {
    const { data: renamed, changes } = exec(board(), { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    const undo = invertChanges(renamed, changes, NOW)
    const { data: again } = exec(renamed, { type: 'task.update', id: 'A3', fields: { title: 'Ship it now' } })
    expect(refusal(again, { type: 'records.restore', changes: undo })).toMatch(/changed this in the meantime/)
  })

  it('refuses a restore that would leave the board broken', () => {
    const start = board()
    // Put back a task under a parent that has since been deleted.
    const { data: moved, changes } = exec(start, { type: 'task.move', id: 'A3', parentId: 'B' })
    const undo = invertChanges(moved, changes, NOW)
    const { data: noA } = exec(moved, { type: 'task.delete', id: 'A' })
    expect(refusal(noA, { type: 'records.restore', changes: undo })).toMatch(/parent task no longer exists/)
    // People aren't board records any more.
    const m = start.members[0]
    expect(refusal(start, { type: 'records.restore', changes: [{ entity: 'member', id: m.id, before: m, after: { ...m, name: 'x' } }] })).toMatch(
      /People/,
    )
  })
})

describe('command schema', () => {
  it('accepts every command the app sends, and rejects junk', () => {
    const start = board()
    const { changes } = exec(start, { type: 'task.delete', id: 'A2' })
    const ok: Command[] = [
      { type: 'task.create', id: 'n1', parentId: null, fields: { title: 'x', due: '2026-01-02' } },
      { type: 'task.update', id: 'A', fields: { start: '', assigneeId: null, color: null } },
      { type: 'task.move', id: 'A3', parentId: 'B', place: { end: true }, list: ['A3'] },
      { type: 'column.update', id: 'todo', fields: { color: 'red' } },
      { type: 'records.restore', changes },
    ]
    for (const c of ok) expect(CommandSchema.safeParse(c).success).toBe(true)
    const bad = [
      { type: 'task.drop', id: 'A' },
      { type: 'task.update', id: 'A', fields: { due: 'tomorrow' } },
      { type: 'task.create', parentId: null, fields: { title: 'x'.repeat(501) } },
      { type: 'board.update', fields: { background: 'plaid' } },
    ]
    for (const c of bad) expect(CommandSchema.safeParse(c).success).toBe(false)
  })

  it('the example board for a real account assigns the owner and has no sample people', () => {
    const d = exampleData('b', 'user-1')
    expect(d.members).toEqual([])
    const assignees = new Set(
      Object.values(d.tasks)
        .map((t) => t.assigneeId)
        .filter(Boolean),
    )
    expect([...assignees]).toEqual(['user-1'])
  })
})

describe('schema', () => {
  it('the example board is valid board data; broken data is rejected', () => {
    expect(BoardDataSchema.safeParse(board()).success).toBe(true)
    const broken = { ...board(), columns: [] }
    expect(BoardDataSchema.safeParse(broken).success).toBe(false)
  })
})

describe('records that were never made by a command (a hand-made undo or file)', () => {
  const task = (id: string, extra: object) => ({
    ...Object.values(board().tasks)[0],
    id,
    title: id,
    parentId: null,
    blockedBy: [],
    labels: [],
    ...extra,
  })

  it('undo refuses an archived task whose parent links loop, and a loop already stored can’t hang a command', () => {
    const start = board()
    const self = task('loop', { parentId: 'loop', archivedAt: NOW })
    expect(refusal(start, { type: 'records.restore', changes: [{ entity: 'task', id: 'loop', before: null, after: self }] })).toMatch(/own subtasks/)
    const pair = [task('a1', { parentId: 'a2', archivedAt: NOW }), task('a2', { parentId: 'a1', archivedAt: NOW })]
    expect(
      refusal(start, { type: 'records.restore', changes: pair.map((after) => ({ entity: 'task' as const, id: after.id, before: null, after })) }),
    ).toMatch(/own subtasks/)
    // Already in the data (from before the check): restoring or deleting it ends, with an answer.
    const stored: BoardData = { ...start, archived: { loop: self, a1: pair[0], a2: pair[1] } }
    for (const id of ['loop', 'a1']) {
      expect(execute(stored, { type: 'task.delete', id }, ctx(stored))).toBeTruthy()
      expect(execute(stored, { type: 'task.restore', id }, ctx(stored))).toBeTruthy()
    }
  })

  it('a reminder’s time must be a moment, and one that isn’t never fires', () => {
    const bad = { type: 'task.update', id: 'x', fields: { reminders: [{ id: 'r', at: 'soon' }] } }
    expect(CommandSchema.safeParse(bad).success).toBe(false)
    expect(CommandSchema.safeParse({ ...bad, fields: { reminders: [{ id: 'r', at: '2026-10-31T14:30:00Z' }] } }).success).toBe(true)
  })

  it('undo drops “set by” on a reminder when that person isn’t on the board', () => {
    const start = board()
    const t = task('rem', { reminders: [{ id: 'r', at: NOW, by: 'someone-else' }] })
    const { data } = exec(start, { type: 'records.restore', changes: [{ entity: 'task', id: 'rem', before: null, after: t }] })
    expect(data.tasks.rem.reminders).toEqual([{ id: 'r', at: NOW }])
  })
})
