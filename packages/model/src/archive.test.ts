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
