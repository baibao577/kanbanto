import { describe, expect, it } from 'vitest'
import { idleDays, lastActivity } from './age'
import { applyChanges } from './changes'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import { matchesFilter } from './table'
import type { BoardData, ViewConfig } from './types'

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

describe('done lists', () => {
  it('recent done lists leave out cards done a while ago, and count them; the rest keep everything', async () => {
    const { buildView, cellKey, NO_ROW } = await import('./view')
    let data = exampleData('b1')
    const idx0 = indexFor(data)
    const doneCol = idx0.columns.find((c) => c.category === 'done')!.id
    const old = idx0.preorder.find((id) => idx0.status.get(id) === doneCol)!
    // One more done card, finished just now.
    data = exec(data, { type: 'task.update', id: 'A3', fields: { status: doneCol } }, new Date().toISOString())
    const idx = indexFor(data)
    const cfg: ViewConfig = { columns: 'status', rows: 'none', filter: 'leaves', parentDisplay: [] }
    const cell = (v: ReturnType<typeof buildView>) => v.cells.get(cellKey(NO_ROW, doneCol)) ?? []
    const now = Date.now()

    const recent = buildView(idx, cfg, { now })
    expect(cell(recent)).toContain('A3')
    expect(cell(recent)).not.toContain(old)
    expect(recent.olderDone.get(doneCol)).toBeGreaterThanOrEqual(1)
    // "Show" brings them back; so does a longer window, or "All".
    expect(cell(buildView(idx, cfg, { now, showOlder: new Set([doneCol]) }))).toContain(old)
    expect(cell(buildView(idx, { ...cfg, doneDays: 3650 }, { now }))).toContain(old)
    expect(cell(buildView(idx, { ...cfg, doneLists: 'all' }, { now }))).toContain(old)
  })
})
