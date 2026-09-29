import { describe, expect, it } from 'vitest'
import { describeChanges } from './activity'
import { applyChanges } from './changes'
import { matchesFilter, sortComparator } from './table'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
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
