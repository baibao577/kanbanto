import { describe, expect, it } from 'vitest'
import { fromDay, taskSpan, toDay } from './dates'
import { buildIndex } from './indexer'
import { matchesFilter, sortComparator } from './table'
import { flattenTree, keepMatching, searchKeep } from './tree'
import { makeTask } from './records'
import { sampleTasks } from './sample'
import { builtIn, EXAMPLE_COLUMNS, type Category, type StatusColumn, type ViewConfig } from './types'
import { buildView, cellKey, groupCell, NO_ROW, TOP_LEVEL } from './view'

// The design's views, expressed as the four display settings.
const VIEWS: Record<string, ViewConfig> = {
  '1': { columns: 'status', rows: 'none', filter: 'all', parentDisplay: ['label'] },
  '2': { columns: 'status', rows: 'none', filter: 'topLevel', parentDisplay: ['checklist'] },
  '3': { columns: 'status', rows: 'rootParent', filter: 'all', parentDisplay: ['rowHeader', 'progress'] },
  '4': { columns: 'status', rows: 'directParent', filter: 'all', parentDisplay: ['rowHeader', 'progress'] },
  '5': { columns: 'status', rows: 'none', filter: 'leaves', parentDisplay: ['label'] },
  '6': { columns: 'status', rows: 'none', filter: 'topLevel', parentDisplay: ['progress'] },
  '7': { columns: 'status', rows: 'none', filter: 'all', parentDisplay: ['label'] },
  '8': { columns: 'parent', rows: 'none', filter: 'topLevel', parentDisplay: [] },
  '10': { columns: 'status', rows: 'none', filter: 'actionable', parentDisplay: ['label'] },
}
/** Lists in the given order (positions a0, a1, …). */
export const cols = (...defs: [id: string, name: string, category: Category][]): StatusColumn[] =>
  defs.map(([id, name, category], i) => ({ id, name, category, position: `a${i}`, ...builtIn() }))

const preset = (id: string, extra: Partial<ViewConfig> = {}) => ({ ...VIEWS[id], ...extra })
const idx = buildIndex(sampleTasks(), 'derived')
const cell = (v: ReturnType<typeof buildView>, row: string, col: string) => v.cells.get(cellKey(row, col)) ?? []

describe('index', () => {
  it('derives parent status from children', () => {
    expect(idx.status.get('A2')).toBe('doing')
    expect(idx.status.get('A')).toBe('doing')
    expect(idx.status.get('B')).toBe('doing')
  })

  it('keeps own status in manual mode', () => {
    const m = buildIndex(sampleTasks(), 'manual')
    expect(m.status.get('A')).toBe('todo')
    expect(m.status.get('B')).toBe('todo')
  })

  it('counts every task below a parent, containers included', () => {
    expect([idx.subDone.get('A'), idx.subTotal.get('A')]).toEqual([1, 5])
    expect([idx.subDone.get('A2'), idx.subTotal.get('A2')]).toEqual([0, 2])
    expect([idx.subDone.get('B'), idx.subTotal.get('B')]).toEqual([0, 1])
    // A finished container counts as one more done task.
    const t = sampleTasks()
    t.A2a.status = 'done'
    t.A2b.status = 'done'
    expect(buildIndex(t, 'derived').subDone.get('A')).toBe(4)
  })

  it('is done only when every child is done', () => {
    const t = sampleTasks()
    t.A2a.status = 'done'
    t.A2b.status = 'done'
    expect(buildIndex(t, 'derived').status.get('A2')).toBe('done')
  })
})

describe('views', () => {
  it('#3 vs #4: A2a goes to row A by top parent, row A2 by direct parent', () => {
    const v3 = buildView(idx, preset('3'))
    const v4 = buildView(idx, preset('4'))
    expect(cell(v3, 'A', 'doing')).toContain('A2a')
    expect(cell(v4, 'A2', 'doing')).toContain('A2a')
    // Row headers aren't repeated as cards.
    expect(cell(v3, 'A', 'doing')).not.toContain('A')
    expect(v4.rows.map((r) => r.key)).not.toContain(TOP_LEVEL)
  })

  it('#5 leaf-only board', () => {
    const v = buildView(idx, preset('5'))
    expect(cell(v, NO_ROW, 'todo')).toEqual(['A2b', 'A3'])
    expect(cell(v, NO_ROW, 'doing')).toEqual(['A2a', 'B1'])
    expect(cell(v, NO_ROW, 'done')).toEqual(['A1'])
  })

  it("main tasks only: every task once, subtasks stay on their parent's card", () => {
    const main = { ...preset('1'), filter: 'main' as const, groupByParent: true }
    // No rows: projects are the cards.
    expect(buildView(idx, main).ids).toEqual(['A', 'B'])
    // A row per project: the project is the row, its direct tasks are the cards; Homepage/Logo stay inside Design.
    const byProject = buildView(idx, { ...main, rows: 'rootParent' })
    const cards = [...byProject.cells.entries()].flatMap(([k, ids]) => ids.map((id) => `${k.split('\u0000')[0]}:${id}`)).sort()
    expect(cards).toEqual(['A:A1', 'A:A2', 'A:A3', 'B:B1'])
    // A project without tasks is still a card.
    const t = sampleTasks()
    t.C = makeTask({ id: 'C', title: 'Solo', status: 'todo', order: 'a9' })
    expect(buildView(buildIndex(t, 'derived'), { ...main, rows: 'rootParent' }).ids).toContain('C')
    // Focused: its direct subtasks.
    expect(buildView(idx, main, { focusId: 'A' }).ids).toEqual(['A1', 'A2', 'A3'])
  })

  it('#6 parents only', () => {
    const v = buildView(idx, preset('6'))
    expect(cell(v, NO_ROW, 'doing')).toEqual(['A', 'B'])
  })

  it('#7 drill-down into A2', () => {
    const v = buildView(idx, preset('7'), { focusId: 'A2' })
    expect(v.ids).toEqual(['A2a', 'A2b'])
  })

  it('#8 parent as column', () => {
    const v = buildView(idx, preset('8'))
    expect(v.columns.map((c) => c.key)).toEqual(['A', 'B'])
    expect(cell(v, NO_ROW, 'A')).toEqual(['A1', 'A2', 'A3'])
    expect(cell(v, NO_ROW, 'B')).toEqual(['B1'])
  })

  it('#10 next actions', () => {
    expect(buildView(idx, preset('10')).ids).toEqual(['A2b', 'A3'])
    const t = sampleTasks()
    t.A3.blockedBy = ['A2']
    expect(buildView(buildIndex(t, 'derived'), preset('10')).ids).toEqual(['A2b'])
  })

  it('free combination: rows by assignee + leaves', () => {
    const v = buildView(idx, { ...preset('5'), rows: 'assignee' })
    expect(cell(v, 'ton', 'todo')).toEqual(['A2b'])
    expect(cell(v, 'mai', 'done')).toEqual(['A1'])
  })
})

describe('subtasks grouped under their parent', () => {
  it('shows a parent as a header in every list where its subtasks are, and never as a card', () => {
    // Design gets 5 subtasks: 3 done, 1 in progress, 1 not started.
    const t = sampleTasks()
    const mk = (id: string, status: string) => (t[id] = makeTask({ id, title: id, parentId: 'A2', status, order: 'a9' }))
    mk('A2c', 'done')
    mk('A2d', 'done')
    t.A2a.status = 'done'
    t.A2b.status = 'todo'
    mk('A2e', 'doing')
    const i = buildIndex(t, 'derived')
    const v = buildView(i, { ...preset('3'), parentDisplay: [], groupByParent: true })
    const groups = (col: string) => groupCell(i, v.cells.get(cellKey('A', col)) ?? [], 'A')
    expect(groups('done')).toEqual([
      { parentId: null, ids: ['A1'] },
      { parentId: 'A2', ids: ['A2a', 'A2c', 'A2d'] },
    ])
    expect(groups('doing')).toEqual([{ parentId: 'A2', ids: ['A2e'] }])
    expect(groups('todo')).toEqual([
      { parentId: null, ids: ['A3'] },
      { parentId: 'A2', ids: ['A2b'] },
    ])
    expect([...v.cells.values()].flat()).not.toContain('A2')
    expect([i.subDone.get('A2'), i.subTotal.get('A2')]).toEqual([3, 5])
  })
})

describe('nested rows', () => {
  it('keeps every parent row in a chain, even when it has no cards of its own', () => {
    // X › Y › Z › W: with "parents only as rows", X and Y have no cards (their only subtask is a row).
    const t = sampleTasks()
    const mk = (id: string, parentId: string | null) => (t[id] = makeTask({ id, title: id, parentId, status: 'todo', order: 'a9' }))
    mk('X', null)
    mk('Y', 'X')
    mk('Z', 'Y')
    mk('W', 'Z')
    const v = buildView(buildIndex(t, 'derived'), preset('4'))
    const keys = v.rows.map((r) => r.key)
    expect(keys).toEqual(expect.arrayContaining(['X', 'Y', 'Z']))
    expect(keys.indexOf('X')).toBeLessThan(keys.indexOf('Y'))
    expect(keys.indexOf('Y')).toBeLessThan(keys.indexOf('Z'))
    // A focused view doesn't pull in rows above the focus.
    const f = buildView(buildIndex(t, 'derived'), preset('4'), { focusId: 'Y' }).rows.map((r) => r.key)
    expect(f).not.toContain('X')
  })
})

describe('focus and search', () => {
  it('focus narrows every filter to the subtree; "top level" means its direct subtasks', () => {
    expect(buildView(idx, preset('5'), { focusId: 'A' }).ids).toEqual(['A1', 'A2a', 'A2b', 'A3'])
    expect(buildView(idx, preset('6'), { focusId: 'A' }).ids).toEqual(['A1', 'A2', 'A3'])
    expect(buildView(idx, preset('8'), { focusId: 'A' }).columns.map((c) => c.key)).toEqual(['A1', 'A2', 'A3'])
  })

  it('search filters cards but keeps the columns', () => {
    const v = buildView(idx, preset('1'), { search: 'LOGO' })
    expect(v.ids).toEqual(['A2b'])
    expect(v.columns).toHaveLength(3)
    expect(buildView(idx, preset('8'), { search: 'invites' }).columns.map((c) => c.key)).toEqual(['A', 'B'])
  })

  it('tree search keeps each match with its ancestors', () => {
    const keep = searchKeep(idx, (t) => t.toLowerCase().includes('logo'))
    expect(flattenTree(idx, idx.roots, new Set(), 100, keep).rows).toEqual(['A', 'A2', 'A2b'])
  })
})

describe('outline table: sort and filter', () => {
  const labels = new Map<string, never>()
  const sortedRows = (key: Parameters<typeof sortComparator>[1]['key'], dir: 'asc' | 'desc') => {
    const cmp = sortComparator(idx, { key, dir }, labels)
    return flattenTree(idx, idx.roots, new Set(['A', 'A2', 'B']), 100, undefined, (ids) => [...ids].sort(cmp)).rows
  }

  it('sorts within each parent, keeping the tree', () => {
    // By title: siblings reorder, but subtasks stay under their parent.
    expect(sortedRows('title', 'asc')).toEqual(['B', 'B1', 'A', 'A1', 'A3', 'A2', 'A2a', 'A2b'])
    expect(sortedRows('title', 'desc')).toEqual(['A', 'A2', 'A2b', 'A2a', 'A3', 'A1', 'B', 'B1'])
  })

  it('puts empty values last in both directions', () => {
    const t = sampleTasks()
    t.A3.due = '2026-01-05'
    t.A1.due = '2026-01-01'
    delete t.A2.due
    const i = buildIndex(t, 'derived')
    const kidsBy = (dir: 'asc' | 'desc') => [...i.childrenOf.get('A')!].sort(sortComparator(i, { key: 'due', dir }, labels))
    expect(kidsBy('asc')).toEqual(['A1', 'A3', 'A2'])
    expect(kidsBy('desc')).toEqual(['A3', 'A1', 'A2'])
  })

  it('filters by status, person and "up next", keeping parents for context', () => {
    const f = { statuses: ['todo'], assignees: ['ton'] }
    const { keep, matched } = keepMatching(idx, (id) => matchesFilter(idx, id, f))
    expect([...matched]).toEqual(['A2b'])
    expect([...keep].sort()).toEqual(['A', 'A2', 'A2b'])
    const upNext = keepMatching(idx, (id) => matchesFilter(idx, id, { upNext: true })).matched
    expect([...upNext]).toEqual(['A2b', 'A3'])
    // "No one assigned" is the empty string.
    const t = sampleTasks()
    delete t.A3.assigneeId
    const i = buildIndex(t, 'derived')
    expect(i.preorder.filter((id) => matchesFilter(i, id, { assignees: [''] }))).toEqual(['A3'])
  })
})

describe('board order', () => {
  it('status lists keep a dragged order, separate from the outline', () => {
    const t = sampleTasks()
    t.A3.rank = 'a1'
    t.A2b.rank = 'a2'
    const i = buildIndex(t, 'derived')
    expect(buildView(i, preset('5')).cells.get(cellKey(NO_ROW, 'todo'))).toEqual(['A3', 'A2b'])
    expect(i.preorder.indexOf('A2b')).toBeLessThan(i.preorder.indexOf('A3')) // outline unchanged
    // Cards never dragged come after the ranked ones.
    t.A2b.rank = undefined
    expect(buildView(buildIndex(t, 'derived'), preset('5')).cells.get(cellKey(NO_ROW, 'todo'))).toEqual(['A3', 'A2b'])
  })
})

describe('custom status columns', () => {
  const flow = cols(
    ['backlog', 'Backlog', 'todo'],
    ['ready', 'Ready', 'todo'],
    ['progress', 'In progress', 'doing'],
    ['review', 'Review', 'doing'],
    ['shipped', 'Shipped', 'done'],
  )
  const tasksIn = (cols: Record<string, string>) => {
    const t = sampleTasks()
    for (const [id, c] of Object.entries(cols)) t[id].status = c
    return t
  }
  const base = { A1: 'shipped', A2a: 'progress', A2b: 'ready', A3: 'backlog', B1: 'review' }

  it('board columns follow the workflow order', () => {
    const v = buildView(buildIndex(tasksIn(base), 'derived', flow), preset('5'))
    expect(v.columns.map((c) => c.title)).toEqual(['Backlog', 'Ready', 'In progress', 'Review', 'Shipped'])
    expect(cell(v, NO_ROW, 'ready')).toEqual(['A2b'])
  })

  it('derived parent joins its children when they share a column', () => {
    const i = buildIndex(tasksIn({ ...base, A2a: 'review', A2b: 'review' }), 'derived', flow)
    expect(i.status.get('A2')).toBe('review')
  })

  it('derived parent with mixed children goes to the first column of the rolled-up category', () => {
    const i = buildIndex(tasksIn(base), 'derived', flow)
    expect(i.status.get('A2')).toBe('progress') // Ready + In progress → doing
    expect(i.status.get('A')).toBe('progress')
    const allDone = buildIndex(tasksIn({ A1: 'shipped', A2a: 'shipped', A2b: 'shipped', A3: 'shipped' }), 'derived', flow)
    expect(allDone.status.get('A')).toBe('shipped')
  })

  it('progress, blocking and next actions use categories, not names', () => {
    const t = tasksIn({ ...base, A3: 'ready' })
    t.A2b.blockedBy = ['A1']
    const i = buildIndex(t, 'derived', flow)
    expect(i.subDone.get('A')).toBe(1)
    expect(buildView(i, preset('10')).ids).toEqual(['A2b', 'A3']) // A1 is Shipped (done) → A2b unblocked
  })

  it('tasks in an unknown column fall back to the first column', () => {
    const i = buildIndex(tasksIn({ A3: 'deleted-col' }), 'derived', flow)
    expect(i.status.get('A3')).toBe('backlog')
  })

  it('lists can be any mix of kinds: missing kinds fall back to the nearest one', () => {
    // No "in progress" list at all: a half-done parent goes to "not started", not to done.
    const noDoing = cols(['ideas', 'Ideas', 'backlog'], ['next', 'Next', 'todo'], ['shipped', 'Shipped', 'done'])
    const i = buildIndex(tasksIn({ A1: 'shipped', A2a: 'next', A2b: 'shipped', A3: 'next', B1: 'next' }), 'derived', noDoing)
    expect(i.firstOf.doing).toBe('next')
    expect(i.status.get('A2')).toBe('next')
    // Only "done"-kind lists: everything still has a home.
    const allDone = cols(['a', 'A', 'done'], ['b', 'B', 'done'])
    const j = buildIndex(tasksIn({ A1: 'a', A2a: 'b', A2b: 'a', A3: 'b', B1: 'a' }), 'derived', allDone)
    expect(j.firstOf.todo).toBe('a')
    expect(j.status.get('A')).toBe('a')
  })
})

describe('backlog and hidden lists', () => {
  const withBacklog = (cols: Record<string, string>) => {
    const t = sampleTasks()
    for (const [id, c] of Object.entries(cols)) t[id].status = c
    return buildIndex(t, 'derived', EXAMPLE_COLUMNS)
  }

  it('a parent whose subtasks are all in the backlog is in the backlog', () => {
    expect(withBacklog({ A2a: 'backlog', A2b: 'backlog' }).status.get('A2')).toBe('backlog')
  })

  it('backlog + not started rolls up to not started; backlog is never "up next"', () => {
    const i = withBacklog({ A2a: 'backlog', A2b: 'todo' })
    expect(i.status.get('A2')).toBe('todo')
    expect(buildView(i, preset('10')).ids).toEqual(['A2b', 'A3'])
    expect(buildView(withBacklog({ A2b: 'backlog' }), preset('10')).ids).toEqual(['A3'])
  })

  it('hiding a list removes the list and its cards', () => {
    const i = withBacklog({ A3: 'backlog' })
    const v = buildView(i, { ...preset('5'), hiddenColumns: ['backlog'] })
    expect(v.columns.map((c) => c.key)).toEqual(['todo', 'doing', 'done'])
    expect(v.ids).not.toContain('A3')
    expect(buildView(i, { ...preset('8'), hiddenColumns: ['backlog'] }).cells.get(cellKey(NO_ROW, 'A'))).toEqual(['A1', 'A2'])
  })

  it('without a backlog list, backlog roll-ups use the nearest later kind', () => {
    expect(buildIndex(sampleTasks(), 'derived').firstOf.backlog).toBe('todo')
  })
})

describe('timeline', () => {
  it('converts dates as whole days', () => {
    expect(fromDay(toDay('2026-02-28') + 1)).toBe('2026-03-01')
    expect(fromDay(toDay('2028-02-28') + 1)).toBe('2028-02-29')
    expect(toDay('1970-01-05') % 7).toBe(4) // the Monday the week grid is aligned to
  })

  it('bars: start..due, one-day when only one is set, none when unscheduled', () => {
    const base = sampleTasks().A3
    expect(taskSpan({ ...base, start: '2026-01-10', due: '2026-01-12' })).toEqual({ start: toDay('2026-01-10'), end: toDay('2026-01-12') })
    expect(taskSpan({ ...base, start: undefined, due: '2026-01-12' })).toEqual({ start: toDay('2026-01-12'), end: toDay('2026-01-12') })
    expect(taskSpan({ ...base, start: '2026-01-15', due: '2026-01-12' })).toEqual({ start: toDay('2026-01-12'), end: toDay('2026-01-15') })
    expect(taskSpan({ ...base, start: undefined, due: undefined })).toBeNull()
  })

  it('parent and child dates are independent', () => {
    const t = sampleTasks()
    const parent = taskSpan(t.A2)!
    t.A2a.start = fromDay(parent.end + 5)
    t.A2a.due = fromDay(parent.end + 9)
    expect(taskSpan(t.A2)).toEqual(parent)
  })

  it('tree rows respect expansion and the row cap', () => {
    const i = buildIndex(sampleTasks(), 'derived')
    expect(flattenTree(i, i.roots, new Set(['A']), 100).rows).toEqual(['A', 'A1', 'A2', 'A3', 'B'])
    expect(flattenTree(i, i.roots, new Set(['A', 'A2', 'B']), 3)).toEqual({ rows: ['A', 'A1', 'A2'], truncated: true })
  })
})
