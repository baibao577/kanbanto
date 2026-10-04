import { describe, expect, it } from 'vitest'
import { applyChanges } from './changes'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import type { BoardData } from './types'

const NOW = '2026-05-01T10:00:00.000Z'
function exec(data: BoardData, cmd: Command) {
  const r = execute(data, cmd, { now: NOW, newId: () => 'new', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return applyChanges(data, r.changes)
}
const doneList = (data: BoardData) => data.columns.find((c) => c.category === 'done')!

describe('archiving keeps what it was', () => {
  it('complete and archive: it and its unfinished subtasks finish first, and each keeps its list and that it was done', () => {
    let data = exampleData('b1') // "decided by subtasks": parents follow their subtasks
    const done = doneList(data)
    const kids = Object.values(data.tasks).filter((t) => t.parentId === 'A')
    data = exec(data, { type: 'task.archive', id: 'A', complete: true })
    const a = data.archived!.A
    expect(a).toMatchObject({ archivedList: done.name, archivedDone: true })
    for (const k of kids) expect(data.archived![k.id]).toMatchObject({ archivedDone: true, archivedList: done.name })
  })

  it('a plain archive keeps the list it was in, not completed; renaming or deleting that list later changes nothing', () => {
    let data = exampleData('b1')
    const idx = indexFor(data)
    const list = data.columns.find((c) => c.id === idx.status.get('A3'))!
    data = exec(data, { type: 'task.archive', id: 'A3' })
    expect(data.archived!.A3).toMatchObject({ archivedList: list.name, archivedDone: false })
    data = exec(data, { type: 'column.update', id: list.id, fields: { name: 'Renamed' } })
    expect(data.archived!.A3.archivedList).toBe(list.name)
  })

  it('restoring puts it back in its list, or (when that list is gone) the first list of the same kind', () => {
    let data = exampleData('b1')
    const done = doneList(data)
    data = exec(data, { type: 'task.archive', id: 'A3', complete: true })
    const other = data.columns.find((c) => c.id !== done.id)!
    data = exec(data, { type: 'column.create', id: 'done2', name: 'Shipped', category: 'done' })
    data = exec(data, { type: 'column.delete', id: done.id, moveTo: other.id })
    data = exec(data, { type: 'task.restore', id: 'A3' })
    expect(data.tasks.A3.status).toBe('done2')
    expect(data.tasks.A3.archivedList).toBeUndefined()
    expect(data.tasks.A3.archivedDone).toBeUndefined()
  })

  it('a board without a done list can’t complete and archive', () => {
    const data = exampleData('b1')
    const only = { ...data, columns: data.columns.map((c) => ({ ...c, category: c.category === 'done' ? ('doing' as const) : c.category })) }
    const r = execute(only, { type: 'task.archive', id: 'A3', complete: true }, { now: NOW, newId: () => 'x', idx: indexFor(only) })
    expect('error' in r && r.error).toMatch(/no list for finished work/)
  })
})

describe('archiving a done list’s older cards', () => {
  const DAY = 86_400_000
  const at = (daysAgo: number) => new Date(Date.parse(NOW) - daysAgo * DAY).toISOString()
  /** A board whose parents follow their subtasks, with cards done at known moments. */
  function board(mode: 'derived' | 'manual' = 'derived'): BoardData {
    let data: BoardData = { ...exampleData('b1'), tasks: {} }
    data = { ...data, board: { ...data.board, mode } }
    const done = doneList(data).id
    const todo = data.columns.find((c) => c.category === 'todo')!.id
    const add = (id: string, parentId: string | null, status: string, doneDaysAgo?: number) => {
      const r = execute(
        data,
        { type: 'task.create', id, parentId, fields: { title: id, status } },
        { now: doneDaysAgo === undefined ? NOW : at(doneDaysAgo), newId: () => id, idx: indexFor(data) },
      )
      if ('error' in r) throw new Error(r.error)
      data = applyChanges(data, r.changes)
    }
    add('old', null, done, 40) // done 40 days ago
    add('new', null, done, 3) // done 3 days ago
    add('open', null, todo)
    add('tree', null, todo) // a parent: done when its subtasks are
    add('tree-a', 'tree', done, 60)
    add('tree-b', 'tree', done, 35)
    add('busy', null, todo) // a parent still being worked on
    add('busy-done', 'busy', done, 90)
    add('busy-open', 'busy', todo)
    return data
  }
  const archive = (data: BoardData, daysAgo: number) => exec(data, { type: 'tasks.archiveDone', status: doneList(data).id, before: at(daysAgo) })

  it('archives the top-level cards done before the moment, each with its subtasks, and nothing else', () => {
    const data = archive(board(), 30)
    expect(Object.keys(data.archived!).sort()).toEqual(['old', 'tree', 'tree-a', 'tree-b'])
    expect(Object.keys(data.tasks).sort()).toEqual(['busy', 'busy-done', 'busy-open', 'new', 'open'])
    for (const t of Object.values(data.archived!)) expect(t).toMatchObject({ archivedAt: NOW, archivedDone: true, archivedList: doneList(data).name })
  })

  it('a parent that follows its subtasks counts from when the last of them got done, and keeps that moment', () => {
    // 35 days ago, not 60: at 37 days only "old" (40) goes, at 30 it goes too.
    expect(Object.keys(archive(board(), 37).archived!)).toEqual(['old'])
    expect(archive(board(), 37).tasks.tree).toBeDefined()
    const data = archive(board(), 30)
    expect(data.archived!.tree.doneAt).toBe(at(35))
    expect(data.archived!['tree-a'].doneAt).toBe(at(60))
    expect(data.archived!.old.doneAt).toBe(at(40))
  })

  it('a finished card under unfinished work stays, however old', () => {
    const data = archive(board(), 1)
    expect(data.tasks['busy-done']).toBeDefined()
    expect(data.archived!['busy-done']).toBeUndefined()
    // Everything top-level and done went, the 3-day-old one too.
    expect(Object.keys(data.archived!).sort()).toEqual(['new', 'old', 'tree', 'tree-a', 'tree-b'])
  })

  it('nothing old enough: no change; and only a done list can be tidied', () => {
    const data = board()
    const ctx = { now: NOW, newId: () => 'x', idx: indexFor(data) }
    expect(execute(data, { type: 'tasks.archiveDone', status: doneList(data).id, before: at(100) }, ctx)).toEqual({ changes: [] })
    const todo = data.columns.find((c) => c.category === 'todo')!.id
    const r = execute(data, { type: 'tasks.archiveDone', status: todo, before: at(1) }, ctx)
    expect('error' in r && r.error).toMatch(/finished work/)
    const gone = execute(data, { type: 'tasks.archiveDone', status: 'nope', before: at(1) }, ctx)
    expect('error' in gone && gone.error).toMatch(/no longer exists/)
  })

  it('with parents set by hand, a done parent goes with all its subtasks, each keeping what it was', () => {
    let data = board('manual')
    const done = doneList(data).id
    // "busy" is moved to Done by hand, with a subtask still open under it.
    const r = execute(data, { type: 'task.update', id: 'busy', fields: { status: done } }, { now: at(20), newId: () => 'x', idx: indexFor(data) })
    if ('error' in r) throw new Error(r.error)
    data = archive(applyChanges(data, r.changes), 10)
    expect(data.archived!.busy).toMatchObject({ archivedDone: true, doneAt: at(20) })
    expect(data.archived!['busy-open']).toMatchObject({ archivedDone: false })
    expect(data.archived!['busy-open'].doneAt).toBeUndefined()
    // In this mode "tree" has its own list (not started), so it isn't done and stays with its subtasks.
    expect(data.tasks.tree).toBeDefined()
  })

  it('restoring one brings it back with its subtasks, done when it was', () => {
    let data = archive(board(), 30)
    data = exec(data, { type: 'task.restore', id: 'tree' })
    expect(Object.keys(data.tasks)).toEqual(expect.arrayContaining(['tree', 'tree-a', 'tree-b']))
    expect(indexFor(data).doneAt.get('tree')).toBe(Date.parse(at(35)))
    expect(data.tasks.tree.archivedDone).toBeUndefined()
    // A parent that follows its subtasks has no done moment of its own on the board.
    expect(data.tasks.tree.doneAt).toBeUndefined()
  })
})
