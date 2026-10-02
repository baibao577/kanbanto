import { describe, expect, it } from 'vitest'
import { applyChanges } from './changes'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import { emptyBoard, exampleData } from './sample'
import type { BoardData } from './types'

const T1 = '2026-05-01T10:00:00.000Z'
const T2 = '2026-05-03T10:00:00.000Z'
function exec(data: BoardData, cmd: Command, now = T1) {
  const r = execute(data, cmd, { now, newId: () => 'new', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return applyChanges(data, r.changes)
}

describe('when a card got done', () => {
  it('is the moment it enters a done list; later edits and reordering leave it alone; leaving the list clears it', () => {
    let data = exec(exampleData('b1'), { type: 'task.move', id: 'A3', status: 'done' })
    expect(data.tasks.A3.doneAt).toBe(T1)
    data = exec(data, { type: 'task.update', id: 'A3', fields: { title: 'Deployed' } }, T2)
    expect(data.tasks.A3).toMatchObject({ doneAt: T1, activeAt: T2 })
    expect(indexFor(data).doneAt.get('A3')).toBe(Date.parse(T1))
    data = exec(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, T2)
    expect(data.tasks.A3.doneAt).toBeUndefined()
    expect(indexFor(data).doneAt.has('A3')).toBe(false)
  })

  it('a card made in a done list, or moved there with others, is done then', () => {
    let data = exec(exampleData('b1'), { type: 'task.create', id: 'T', parentId: null, fields: { title: 'Was done already', status: 'done' } })
    expect(data.tasks.T.doneAt).toBe(T1)
    data = exec(data, { type: 'tasks.moveToList', ids: ['C1', 'C2'], status: 'done' }, T2)
    expect([data.tasks.C1.doneAt, data.tasks.C2.doneAt]).toEqual([T2, T2])
  })

  it('archiving keeps it (complete and archive sets it); restoring brings it back', () => {
    let data = exec(exampleData('b1'), { type: 'task.move', id: 'A3', status: 'done' })
    data = exec(data, { type: 'task.archive', id: 'A3' }, T2)
    expect(data.archived!.A3.doneAt).toBe(T1)
    data = exec(data, { type: 'task.restore', id: 'A3' }, T2)
    expect(data.tasks.A3.doneAt).toBe(T1)

    data = exec(data, { type: 'task.archive', id: 'B1', complete: true }, T2)
    expect(data.archived!.B1).toMatchObject({ archivedDone: true, doneAt: T2 })
    // Archived unfinished: no done date.
    data = exec(data, { type: 'task.archive', id: 'C1' }, T2)
    expect(data.archived!.C1.doneAt).toBeUndefined()
  })

  it('a deleted done list: its cards keep their date in another done list, and lose it in one that isn’t', () => {
    let data = exec(exampleData('b1'), { type: 'task.move', id: 'A3', status: 'done' })
    data = exec(data, { type: 'column.create', id: 'shipped', name: 'Shipped', category: 'done' }, T2)
    data = exec(data, { type: 'column.delete', id: 'done', moveTo: 'shipped' }, T2)
    expect(data.tasks.A3).toMatchObject({ status: 'shipped', doneAt: T1 })
    data = exec(data, { type: 'column.delete', id: 'shipped', moveTo: 'todo' }, T2)
    expect(data.tasks.A3.doneAt).toBeUndefined()
  })

  it('a parent that follows its subtasks is done when the last of them was', () => {
    // C has two subtasks, C1 and C2.
    let data = exec(exampleData('b1'), { type: 'task.move', id: 'C1', status: 'done' }, T1)
    expect(indexFor(data).doneAt.has('C')).toBe(false)
    data = exec(data, { type: 'task.move', id: 'C2', status: 'done' }, T2)
    expect(indexFor(data).category.get('C')).toBe('done')
    expect(indexFor(data).doneAt.get('C')).toBe(Date.parse(T2))
  })

  it('a done card without a date (its list became a done list later) counts from its last real change', () => {
    let data = exampleData('b1')
    data = { ...data, tasks: { ...data.tasks, A3: { ...data.tasks.A3, activeAt: T1 } } }
    data = exec(data, { type: 'column.update', id: 'todo', fields: { category: 'done' } }, T2)
    expect(data.tasks.A3.doneAt).toBeUndefined()
    expect(indexFor(data).doneAt.get('A3')).toBe(Date.parse(T1))
  })

  it('goes with a card moved to another board when it lands in a done list', () => {
    let n = 0
    const source = exec(exampleData('src'), { type: 'task.move', id: 'B1', status: 'done' })
    const target = { ...emptyBoard('dst', 'Home', T2), members: [] }
    const plan = planMove(source, target, 'B', {}, { now: T2, newId: () => `n${++n}` })
    if ('error' in plan) throw new Error(plan.error)
    const there = applyChanges(target, plan.target)
    expect(there.tasks[plan.ids.get('B1')!].doneAt).toBe(T1)
    expect(there.tasks[plan.ids.get('B2')!].doneAt).toBeUndefined()
  })
})
