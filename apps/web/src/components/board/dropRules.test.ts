import { indexFor } from '@kanbanto/model/indexer'
import { DEFAULT_DISPLAY } from '@kanbanto/model/prefs'
import { exampleData } from '@kanbanto/model/sample'
import type { ViewConfig } from '@kanbanto/model/types'
import { buildView, cellKey, NO_ROW, TOP_LEVEL, UNASSIGNED } from '@kanbanto/model/view'
import { describe, expect, it } from 'vitest'
import { arrivalIn, BLOCKED, blockReason, dropCommand, dropGroupCommand, newCardIn, type DropContext } from './dropRules'

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

  it('grouped lists keep their order: groups and cards without a parent header go anywhere in it', () => {
    // Doing: [Design: A2a] [Event: B1]. To Do: [Design: A2b] [Launch website: A3].
    const c = board({ groupByParent: true })
    const doing = cellKey(NO_ROW, 'doing')
    const event = { parentId: 'B', ids: ['B1'], row: NO_ROW, cell: doing }
    // A group re-ordered in its own list; dropped where it already is, nothing changes.
    expect(dropGroupCommand(c, event, NO_ROW, 'doing', 0)).toMatchObject({ type: 'tasks.moveToList', ids: ['B1'], list: ['B1', 'A2a'] })
    expect(dropGroupCommand(c, event, NO_ROW, 'doing', 1)).toBeNull()
    expect(dropGroupCommand(c, event, NO_ROW, 'doing', 2)).toBeNull()
    // Into another list at a position; joining its parent's cards already there.
    expect(dropGroupCommand(c, event, NO_ROW, 'todo', 1)).toMatchObject({ status: 'todo', list: ['A2b', 'B1', 'A3'] })
    const design = { parentId: 'A2', ids: ['A2a'], row: NO_ROW, cell: doing }
    expect(dropGroupCommand(c, design, NO_ROW, 'todo', 2)).toMatchObject({ list: ['A3', 'A2b', 'A2a'] })
    expect(dropGroupCommand(board({ groupByParent: true, rows: 'rootParent' }), { ...design, row: 'A' }, 'B', 'todo', 0)).toBe(BLOCKED.project)

    // A subtask dropped where its parent has no group yet starts one there.
    expect(dropCommand(c, 'A3', NO_ROW, 'doing', 1)).toMatchObject({ status: 'doing', list: ['A2a', 'A3', 'B1'] })
    // Inside its parent's group, `at` is a position in the group.
    expect(dropCommand(c, 'A2b', NO_ROW, 'todo', 0)).toBeNull()

    // With a row per project, the project's own tasks have no header: they go between groups.
    const rows = board({ groupByParent: true, rows: 'rootParent' })
    expect(dropCommand(rows, 'A3', 'A', 'todo', 0)).toMatchObject({ list: ['A3', 'A2b'] })
    expect(dropCommand(rows, 'A3', 'A', 'todo', 2)).toBeNull()
  })

  it('a list shown by priority keeps the order made by hand underneath: moving a card within it changes nothing, and one arriving goes to its end', () => {
    const base = exampleData('b1')
    const data = {
      ...base,
      tasks: { ...base.tasks, A4: { ...base.tasks.A4, priority: 'low' as const }, B2: { ...base.tasks.B2, priority: 'urgent' as const } },
    }
    const idx = indexFor(data)
    const cfg: ViewConfig = { ...DEFAULT_DISPLAY.board, groupByParent: false, hiddenColumns: [], listOrder: { backlog: 'priority' } }
    const c: DropContext = { data, idx, config: cfg, cells: buildView(idx, cfg).cells }
    const shown = c.cells.get(cellKey(NO_ROW, 'backlog'))!
    const hand = buildView(idx, { ...cfg, listOrder: {} }).cells.get(cellKey(NO_ROW, 'backlog'))!
    // Most important first; cards without a priority after them, as they were.
    expect(shown.slice(0, 2)).toEqual(['B2', 'A4'])
    expect(shown.slice(2)).toEqual(hand.filter((id) => id !== 'B2' && id !== 'A4'))
    expect(hand.indexOf('A4')).toBeLessThan(hand.indexOf('B2'))
    expect(dropCommand(c, 'A4', NO_ROW, 'backlog', 0)).toBeNull()
    const cmd = dropCommand(c, 'A3', NO_ROW, 'backlog', 0) as { status: string; list: string[] }
    expect(cmd.status).toBe('backlog')
    expect(cmd.list).toEqual([...hand, 'A3'])
    expect(newCardIn(c, undefined, NO_ROW, 'backlog', 'New').rankAfter).toBe(hand.at(-1))
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

describe('a card dropped in from another board (the Inbox panel)', () => {
  it('takes the list it was dropped on, and its place among the cards the list shows', () => {
    const c = board({ filter: 'topLevel' }, 'manual')
    const cell = c.cells.get(cellKey(NO_ROW, 'todo'))!
    expect(arrivalIn(c, undefined, NO_ROW, 'todo', 1)).toEqual({ list: 'todo', parentId: null, order: { ids: cell, at: 1 } })
    // Past the end (a folded list): last.
    expect(arrivalIn(c, undefined, NO_ROW, 'todo', 1_000_000).order).toEqual({ ids: cell, at: cell.length })
    // While focused on a task, it lands under it, like a card typed there.
    expect(arrivalIn(c, 'A', NO_ROW, 'doing', 0).parentId).toBe('A')
  })

  it('with subtasks grouped under their parent: its place is counted in cards, whole groups before it', () => {
    const c = board({ groupByParent: true })
    const cell = c.cells.get(cellKey(NO_ROW, 'todo'))!
    // (To Do shows two cards, each under its own parent's header: after the first group is after its one card.)
    expect(cell).toHaveLength(2)
    expect(arrivalIn(c, undefined, NO_ROW, 'todo', 1).order).toEqual({ ids: cell, at: 1 })
    expect(arrivalIn(c, undefined, NO_ROW, 'todo', 2).order).toEqual({ ids: cell, at: 2 })
  })

  it('in a row per parent it goes under that parent; in a list shown in another order, to the end of the one made by hand', () => {
    expect(arrivalIn(board({ rows: 'directParent' }), undefined, 'B', 'todo', 0)).toMatchObject({ list: 'todo', parentId: 'B' })
    expect(arrivalIn(board({ rows: 'directParent' }), undefined, TOP_LEVEL, 'todo', 0).parentId).toBe(null)
    expect(arrivalIn(board({ listOrder: { todo: 'priority' } }), undefined, NO_ROW, 'todo', 0)).toEqual({ list: 'todo', parentId: null })
  })
})
