import { describe, expect, it } from 'vitest'
import { applyChanges } from './changes'
import { execute, type Command } from './commands'
import { buildIndex, indexFor } from './indexer'
import { positionsBetween } from './position'
import { defaultPrefs } from './prefs'
import { makeTask } from './records'
import { ViewPrefsSchema } from './schema'
import { changedAt, listSort, sortComparator } from './table'
import { DEFAULT_COLUMNS, isReversed, LIST_ORDERS, listOrderKey, reversed, type BoardData, type ListOrder } from './types'
import { buildView, cellKey, NO_ROW } from './view'

/**
 * Four cards in To Do, in this order by hand: b, d, a, c. Made in the order a, b, c, d (a day apart); last changed
 * in the order d, c (no real change since it was made), a, b.
 */
const at = (day: number, hour = 9) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`
function board(): BoardData {
  const rank = positionsBetween(null, null, 4)
  const card = (id: string, made: number, active: number | undefined, place: number) =>
    makeTask(
      { id, title: id.toUpperCase(), status: 'todo', order: rank[place], rank: rank[place], ...(active && { activeAt: at(active) }) },
      // (Every card was last written on the 20th: putting them in order by hand does that, and isn't a change.)
      { createdAt: at(made), updatedAt: at(20), version: 2 },
    )
  const tasks = [card('a', 1, 12, 2), card('b', 2, 14, 0), card('c', 3, undefined, 3), card('d', 4, 5, 1)]
  // (c has no "last real change" of its own: an older card, whose last write stands in.)
  tasks[2] = { ...tasks[2], updatedAt: at(8) }
  return {
    board: { id: 'b1', name: 'B', mode: 'manual', createdAt: at(1), updatedAt: at(1), version: 1 },
    members: [],
    columns: DEFAULT_COLUMNS,
    labels: [],
    fields: [],
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  }
}
const inTodo = (data: BoardData, by?: ListOrder) => {
  const idx = buildIndex(data.tasks, data.board.mode, data.columns, data.members, data.fields)
  const view = buildView(idx, { columns: 'status', rows: 'none', filter: 'all', parentDisplay: [], ...(by && { listOrder: { todo: by } }) })
  return view.cells.get(cellKey(NO_ROW, 'todo'))
}

describe('sorting by when a card was made or last changed', () => {
  it('the Outline sorts by either, both ways', () => {
    const idx = indexFor(board())
    const sorted = (key: 'created' | 'updated', dir: 'asc' | 'desc') => ['a', 'b', 'c', 'd'].sort(sortComparator(idx, { key, dir }, new Map()))
    expect(sorted('created', 'asc')).toEqual(['a', 'b', 'c', 'd'])
    expect(sorted('created', 'desc')).toEqual(['d', 'c', 'b', 'a'])
    expect(sorted('updated', 'asc')).toEqual(['d', 'c', 'a', 'b'])
    expect(sorted('updated', 'desc')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('a list on the Board is ordered by either, newest or oldest first; by hand it is as it was dragged', () => {
    const data = board()
    expect(inTodo(data)).toEqual(['b', 'd', 'a', 'c'])
    expect(inTodo(data, 'created')).toEqual(['d', 'c', 'b', 'a'])
    expect(inTodo(data, 'created-rev')).toEqual(['a', 'b', 'c', 'd'])
    expect(inTodo(data, 'updated')).toEqual(['b', 'a', 'c', 'd'])
    expect(inTodo(data, 'updated-rev')).toEqual(['d', 'c', 'a', 'b'])
  })

  it('every order can be turned round, and turned back', () => {
    const data = board()
    expect(inTodo(data, 'title')).toEqual(['a', 'b', 'c', 'd'])
    expect(inTodo(data, 'title-rev')).toEqual(['d', 'c', 'b', 'a'])
    for (const by of LIST_ORDERS) {
      expect(reversed(reversed(by))).toBe(by)
      expect(isReversed(reversed(by))).toBe(!isReversed(by))
      expect(listSort(reversed(by))).toEqual({ key: listOrderKey(by), dir: listSort(by).dir === 'asc' ? 'desc' : 'asc' })
      expect(LIST_ORDERS).toContain(reversed(by))
    }
    // Dates start with the newest; the rest with the smallest.
    expect(listSort('created')).toEqual({ key: 'created', dir: 'desc' })
    expect(listSort('due')).toEqual({ key: 'due', dir: 'asc' })
  })

  it('“last changed” is the last real work: reordering a card doesn’t move it, editing it does', () => {
    const data = board()
    const run = (d: BoardData, cmd: Command, now: string) => {
      const r = execute(d, cmd, { now, newId: () => 'x', idx: indexFor(d) })
      if ('error' in r) throw new Error(r.error)
      return applyChanges(d, r.changes)
    }
    // d is dragged to the end of the list, much later: it was written, not changed.
    const moved = run(data, { type: 'task.move', id: 'd', list: ['b', 'a', 'c', 'd'] }, at(25))
    expect(moved.tasks.d.updatedAt).toBe(at(25))
    expect(changedAt(moved.tasks.d)).toBe(at(5))
    expect(inTodo(moved, 'updated')).toEqual(['b', 'a', 'c', 'd'])
    // Renamed, it is the latest.
    const renamed = run(moved, { type: 'task.update', id: 'd', fields: { title: 'D, again' } }, at(26))
    expect(changedAt(renamed.tasks.d)).toBe(at(26))
    expect(inTodo(renamed, 'updated')).toEqual(['d', 'b', 'a', 'c'])
    // Cards made at the same moment keep the order they were dragged into.
    const twins = { ...data, tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, { ...t, createdAt: at(1) }])) }
    expect(inTodo(twins, 'created')).toEqual(['b', 'd', 'a', 'c'])
  })

  it('saved settings keep the new orders and the two extra columns, and drop what they don’t know', () => {
    const prefs = {
      ...defaultPrefs(),
      display: { board: { ...defaultPrefs().display.board, listOrder: { todo: 'created-rev', done: 'updated' } } },
      outline: { sort: { key: 'updated', dir: 'desc' }, extra: ['created', 'updated'] },
    }
    expect(ViewPrefsSchema.parse(prefs)).toEqual(prefs)
    const odd = {
      ...prefs,
      outline: { extra: ['created', 'colour'] },
      display: { board: { ...prefs.display.board, listOrder: { todo: 'sideways' } } },
    }
    const read = ViewPrefsSchema.parse(odd)
    expect(read.outline.extra).toBeUndefined()
    expect(read.display.board.listOrder).toBeUndefined()
  })
})
