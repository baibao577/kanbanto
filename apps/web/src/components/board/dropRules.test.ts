import { indexFor } from '@kanbanto/model/indexer'
import { DEFAULT_DISPLAY } from '@kanbanto/model/prefs'
import { exampleData } from '@kanbanto/model/sample'
import type { ViewConfig } from '@kanbanto/model/types'
import { buildView, cellKey, NO_ROW, TOP_LEVEL, UNASSIGNED } from '@kanbanto/model/view'
import { describe, expect, it } from 'vitest'
import { BLOCKED, blockReason, dropCommand, dropGroupCommand, newCardIn, type DropContext } from './dropRules'

/**
 * The example board: A "Launch website" (A1 done, A2 Design → A2a doing / A2b todo, A3 todo, A4 backlog),
 * B "Event" (B1 doing, B2 backlog), C "Newsletter redesign" (backlog). Parent status follows subtasks.
 */
function board(config: Partial<ViewConfig> = {}, mode: 'derived' | 'manual' = 'derived'): DropContext {
  const base = exampleData('b1')
  const data = { ...base, board: { ...base.board, mode } }
  const idx = indexFor(data)
  const cfg: ViewConfig = { ...DEFAULT_DISPLAY.board, groupByParent: false, ...config }
  return { data, idx, config: cfg, cells: buildView(idx, cfg).cells }
}

describe('dropping a card on the board', () => {
  it('in status lists: a new list means a new status, and the list is re-ordered with the card in place', () => {
    const c = board()
    const cmd = dropCommand(c, 'A3', NO_ROW, 'doing', 0)
    expect(cmd).toMatchObject({ type: 'task.move', id: 'A3', status: 'doing' })
    expect((cmd as { list: string[] }).list[0]).toBe('A3')
    // Dropped back where it was: nothing to do.
    const cell = c.cells.get(cellKey(NO_ROW, 'todo'))!
    expect(dropCommand(c, cell[0], NO_ROW, 'todo', 0)).toBeNull()
  })

  it('a parent whose status follows its subtasks can’t be moved to another list (it can when set by hand)', () => {
    expect(blockReason(board(), 'A2', NO_ROW, 'done')).toBe(BLOCKED.derived)
    expect(blockReason(board({}, 'manual'), 'A2', NO_ROW, 'done')).toBeNull()
  })

  it('with a row per project, cards stay in their project', () => {
    const c = board({ rows: 'rootParent' })
    expect(blockReason(c, 'A3', 'B', 'todo')).toBe(BLOCKED.project)
    expect(blockReason(c, 'A3', 'A', 'doing')).toBeNull()
  })

  it('with a row per parent, a new row means a new parent — but never one of its own subtasks', () => {
    const c = board({ rows: 'directParent' })
    expect(dropCommand(c, 'A3', 'B', 'todo', 0)).toMatchObject({ type: 'task.move', id: 'A3', parentId: 'B' })
    expect(dropCommand(c, 'B1', TOP_LEVEL, 'doing', 0)).toMatchObject({ parentId: null })
    expect(blockReason(c, 'A2', 'A2a', 'doing')).toBe(BLOCKED.cycle)
  })

  it('with a row per person, a new row means a new assignee', () => {
    const c = board({ rows: 'assignee' })
    expect(dropCommand(c, 'A3', 'ton', 'todo', 0)).toMatchObject({ assigneeId: 'ton' })
    expect(dropCommand(c, 'A3', UNASSIGNED, 'todo', 0)).toMatchObject({ assigneeId: null })
  })

  it('in parent columns: a new column means a new parent, placed among its new siblings', () => {
    const c = board({ columns: 'parent' })
    const cmd = dropCommand(c, 'A3', NO_ROW, 'B', 0)
    expect(cmd).toMatchObject({ type: 'task.move', id: 'A3', parentId: 'B' })
    expect(blockReason(c, 'A', NO_ROW, 'A2')).toBe(BLOCKED.cycle)
  })

  it('a parent’s group moves all its cards from that list to the end of another', () => {
    const c = board({ groupByParent: true })
    const g = { parentId: 'A2', ids: ['A2a'], row: NO_ROW, cell: cellKey(NO_ROW, 'doing') }
    expect(dropGroupCommand(c, g, NO_ROW, 'doing')).toBeNull()
    const cmd = dropGroupCommand(c, g, NO_ROW, 'todo')
    expect(cmd).toMatchObject({ type: 'tasks.moveToList', ids: ['A2a'], status: 'todo' })
    expect((cmd as { list: string[] }).list.at(-1)).toBe('A2a')
    expect(dropGroupCommand(board({ rows: 'rootParent' }), { ...g, row: 'A' }, 'B', 'todo')).toBe(BLOCKED.project)
  })

  it('a new card takes its cell’s list, parent and person, and lands at the bottom', () => {
    const byPerson = newCardIn(board({ rows: 'assignee' }), undefined, 'ploy', 'doing', 'Call the venue')
    expect(byPerson).toMatchObject({ parentId: null, fields: { title: 'Call the venue', status: 'doing', assigneeId: 'ploy' } })
    const byParent = newCardIn(board({ rows: 'directParent' }), undefined, 'B', 'todo', 'Order food')
    expect(byParent).toMatchObject({ parentId: 'B', fields: { status: 'todo' } })
    const zoomedIn = newCardIn(board(), 'C', NO_ROW, 'todo', 'Choose fonts')
    expect(zoomedIn.parentId).toBe('C')
  })
})
