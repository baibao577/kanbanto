import { describe, expect, it } from 'vitest'
import { describeChanges } from './activity'
import { applyChanges, invertChanges } from './changes'
import { matchesFilter, sortComparator } from './table'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import type { BoardData } from './types'
import { exampleData } from './sample'

const data = exampleData('b1', 'ann')
const run = (cmd: Command) => {
  const r = execute(data, cmd, { now: '2026-10-01T00:00:00Z', newId: () => 'new1', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return describeChanges(data, r.changes).map((i) => i.text)
}

describe('the activity log, in words', () => {
  it('says what a change did', () => {
    expect(run({ type: 'task.create', parentId: 'A', fields: { title: 'Write copy' } })).toEqual(['added “Write copy” under “Launch website”'])
    expect(run({ type: 'task.update', id: 'A3', fields: { status: 'done' } })).toEqual(['moved “Deploy” to Done'])
    expect(run({ type: 'task.update', id: 'A3', fields: { title: 'Ship it', assigneeId: null, due: '2026-10-20' } })).toEqual([
      'renamed “Deploy” to “Ship it”',
      'unassigned “Ship it”',
      'set “Ship it” due 2026-10-20',
    ])
    expect(run({ type: 'task.move', id: 'A3', parentId: 'B' })).toEqual(['moved “Deploy” under “Event”'])
    expect(run({ type: 'column.update', id: 'todo', fields: { name: 'Next' } })).toEqual(['renamed the list “To Do” to “Next”'])
    expect(run({ type: 'task.update', id: 'A3', fields: { priority: 'urgent' } })).toEqual(['set the priority of “Deploy” to urgent'])
    expect(run({ type: 'board.update', fields: { description: 'The website launch' } })).toEqual(['changed what the board is for'])
  })

  it('says each line again as the card’s own history reads it: without its name, with what it was before', () => {
    const own = (cmd: Command) => {
      const r = execute(data, cmd, { now: '2026-10-01T00:00:00Z', newId: () => 'new1', idx: indexFor(data) })
      if ('error' in r) throw new Error(r.error)
      return describeChanges(data, r.changes).map((i) => (i.date ? `${i.own} [${i.date}]` : i.own))
    }
    expect(own({ type: 'task.create', parentId: 'A', fields: { title: 'Write copy' } })).toEqual(['added it under “Launch website”'])
    expect(own({ type: 'task.create', parentId: null, fields: { title: 'Buy groceries' } })).toEqual(['added it'])
    expect(own({ type: 'task.update', id: 'A3', fields: { status: 'done' } })).toEqual(['moved it from To Do to Done'])
    // A date is left for whoever shows the line to write in the reader's own words.
    expect(
      own({ type: 'task.update', id: 'A3', fields: { title: 'Ship it', assigneeId: null, due: '2026-10-20', start: '2026-10-12T02:00:00.000Z' } }),
    ).toEqual([
      'renamed it from “Deploy” to “Ship it”',
      'unassigned it',
      'set it due {date} [2026-10-20]',
      'set it to start {date} [2026-10-12T02:00:00Z]',
    ])
    expect(own({ type: 'task.update', id: 'A2a', fields: { due: '', description: 'New words', priority: 'urgent' } })).toEqual([
      'cleared its due date',
      'edited the description',
      'set the priority to Urgent',
    ])
    expect(own({ type: 'task.move', id: 'A3', parentId: 'B' })).toEqual(['moved it under “Event”'])
    expect(own({ type: 'task.move', id: 'A3', parentId: null })).toEqual(['moved it to the top level'])
    // Labels are named, the ones put on and the ones taken off.
    expect(own({ type: 'task.update', id: 'A2a', fields: { labels: ['ui', 'brand'] } })).toEqual(['added the label “brand”'])
    expect(own({ type: 'task.update', id: 'A2a', fields: { labels: ['brand', 'marketing'] } })).toEqual([
      'added the labels “brand”, “marketing” and removed the label “ui”',
    ])
    expect(own({ type: 'task.archive', id: 'A3', complete: true }).at(-1)).toBe('archived it as completed')
    // What isn't about one task has no such line.
    expect(own({ type: 'column.update', id: 'todo', fields: { name: 'Next' } })).toEqual([undefined])
  })

  it('priority: set, cleared, filtered and sorted most important first', () => {
    const r = execute(
      data,
      { type: 'task.update', id: 'A3', fields: { priority: 'high' } },
      { now: '2026-10-01T00:00:00Z', newId: () => 'x', idx: indexFor(data) },
    )
    if ('error' in r) throw new Error(r.error)
    const next = applyChanges(data, r.changes)
    expect(next.tasks.A3.priority).toBe('high')
    const idx = indexFor(next)
    expect(matchesFilter(idx, 'A3', { priorities: ['urgent', 'high'] })).toBe(true)
    expect(matchesFilter(idx, 'A1', { priorities: ['urgent', 'high'] })).toBe(false)
    expect(matchesFilter(idx, 'A1', { priorities: [''] })).toBe(true)
    const sorted = ['A1', 'A3'].sort(sortComparator(idx, { key: 'priority', dir: 'asc' }, new Map()))
    expect(sorted).toEqual(['A3', 'A1'])
    const cleared = execute(
      next,
      { type: 'task.update', id: 'A3', fields: { priority: null } },
      { now: '2026-10-01T00:00:00Z', newId: () => 'x', idx },
    )
    expect('changes' in cleared && (cleared.changes[0].after as { priority?: string }).priority).toBeUndefined()
  })

  it('reordering alone isn’t news; a big change is cut short', () => {
    expect(run({ type: 'task.move', id: 'A2b', parentId: 'A2', place: { before: 'A2a' } })).toEqual([])
    const lines = run({ type: 'task.delete', id: 'A' })
    expect(lines[0]).toBe('deleted “Launch website”')
    expect(lines.length).toBeLessThanOrEqual(20)
  })
})

describe('archiving', () => {
  const now = '2026-10-01T00:00:00Z'
  const exec = (d: BoardData, cmd: Command) => {
    const r = execute(d, cmd, { now, newId: () => 'n1', idx: indexFor(d) })
    if ('error' in r) throw new Error(r.error)
    return r.changes
  }

  it('puts a task and its subtasks away, out of the index, and brings them back', () => {
    const put = exec(data, { type: 'task.archive', id: 'A2' })
    expect(describeChanges(data, put).map((i) => i.text)).toEqual([`archived “${data.tasks.A2.title}”`])
    const away = applyChanges(data, put)
    expect(away.tasks.A2).toBeUndefined()
    expect(away.tasks.A2a).toBeUndefined()
    expect(Object.keys(away.archived!).sort()).toEqual(['A2', 'A2a', 'A2b'])
    expect(indexFor(away).preorder).not.toContain('A2a')

    const back = applyChanges(away, exec(away, { type: 'task.restore', id: 'A2' }))
    expect(back.tasks.A2.parentId).toBe('A')
    expect(back.tasks.A2a.parentId).toBe('A2')
    expect(back.tasks.A2.archivedAt).toBeUndefined()
    expect(Object.keys(back.archived ?? {})).toEqual([])
  })

  it('restores to the top level (and a list that exists) when its parent or list is gone', () => {
    let d = applyChanges(data, exec(data, { type: 'task.archive', id: 'A2' }))
    d = applyChanges(d, exec(d, { type: 'task.delete', id: 'A' }))
    const back = applyChanges(d, exec(d, { type: 'task.restore', id: 'A2' }))
    expect(back.tasks.A2.parentId).toBe(null)
    expect(indexFor(back).roots).toContain('A2')
  })

  it('undo works, and deleting an archived task is for good', () => {
    const put = exec(data, { type: 'task.archive', id: 'A3' })
    const away = applyChanges(data, put)
    const undone = applyChanges(away, exec(away, { type: 'records.restore', changes: invertChanges(away, put, now) }))
    expect(undone.tasks.A3.archivedAt).toBeUndefined()
    const gone = applyChanges(away, exec(away, { type: 'task.delete', id: 'A3' }))
    expect(gone.archived?.A3).toBeUndefined()
    expect(gone.tasks.A3).toBeUndefined()
  })
})
