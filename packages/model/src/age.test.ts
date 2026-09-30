import { describe, expect, it } from 'vitest'
import { idleDays, lastActivity } from './age'
import { applyChanges } from './changes'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import { matchesFilter } from './table'
import type { BoardData } from './types'

const at = (d: string) => `2026-05-${d}T10:00:00.000Z`
function exec(data: BoardData, cmd: Command, now: string) {
  const r = execute(data, cmd, { now, newId: () => 'new', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return applyChanges(data, r.changes)
}

describe('card age', () => {
  it('moves and edits count as activity; reordering and moving in the tree don’t', () => {
    let data = exampleData('b1')
    const start = data.tasks.A3.updatedAt
    // An older card (no activeAt yet): reordering keeps its last change as its last activity.
    data = exec(data, { type: 'task.move', id: 'A3', list: ['A3'] }, at('02'))
    expect(data.tasks.A3.activeAt).toBe(start)
    data = exec(data, { type: 'task.update', id: 'A3', fields: { title: 'Deploy it' } }, at('03'))
    expect(data.tasks.A3.activeAt).toBe(at('03'))
    data = exec(data, { type: 'task.move', id: 'A3', parentId: null }, at('04'))
    expect(data.tasks.A3.activeAt).toBe(at('03'))
    data = exec(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, at('05'))
    expect(data.tasks.A3.activeAt).toBe(at('05'))
  })

  it('a card’s age counts its subtasks and its latest comment', () => {
    let data = exampleData('b1')
    data = exec(data, { type: 'task.update', id: 'A', fields: { title: 'Launch' } }, at('01'))
    data = exec(data, { type: 'task.update', id: 'A3', fields: { title: 'Deploy it' } }, at('06'))
    const idx = indexFor(data)
    expect(lastActivity(idx, 'A')).toBe(Date.parse(at('06')))
    expect(lastActivity(idx, 'A3', { A3: at('08') })).toBe(Date.parse(at('08')))
    expect(idleDays(Date.parse(at('06')), Date.parse(at('16')) + 3_600_000)).toBe(10)
  })

  it('the filter keeps open cards with no activity for that many days', () => {
    const data = exampleData('b1')
    const idx = indexFor(data)
    const old = [...idx.preorder].find((id) => idx.category.get(id) !== 'done')!
    const done = [...idx.preorder].find((id) => idx.category.get(id) === 'done')!
    // The sample board's cards are older than a day; a fresh comment makes one active again.
    expect(matchesFilter(idx, old, { idle: 1 })).toBe(true)
    expect(matchesFilter(idx, done, { idle: 1 })).toBe(false)
    expect(matchesFilter(idx, old, { idle: 1 }, { [old]: new Date().toISOString() })).toBe(false)
  })
})
