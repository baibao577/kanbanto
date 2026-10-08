import { describe, expect, it } from 'vitest'
import { commonValue, fieldOnCards, labelOnCards, labelShares, setOnCards, stillThere, theirSubtasks, withWhatIsUnder, type BulkChange } from './bulk'
import { applyChanges, invertChanges } from './changes'
import { execute, type Command } from './commands'
import type { BoardField } from './fields'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import { CommandSchema } from './schema'
import type { BoardData } from './types'

const NOW = '2026-10-08T10:00:00.000Z'
const reviewers: BoardField = { id: 'who', name: 'Reviewers', type: 'person', many: true }
const stage: BoardField = { id: 'stage', name: 'Stage', type: 'choice', options: [{ id: 'new', name: 'New', color: 'blue' }] }
const hours: BoardField = { id: 'hours', name: 'Hours', type: 'number' }

/**
 * The example board: Launch website (A) with Buy domain (A1, done), Design (A2) with Homepage (A2a, "ui") and Logo
 * (A2b, "brand"), Deploy (A3), a blog post (A4, "marketing"); Event (B) with B1 and B2; Newsletter (C, "marketing")
 * with C1 ("brand") and C2. A parent's list follows its subtasks.
 */
function board(custom: Record<string, Record<string, unknown>> = {}, mode: 'derived' | 'manual' = 'derived'): BoardData {
  const data = exampleData('b1')
  return {
    ...data,
    board: { ...data.board, mode },
    fields: [reviewers, stage, hours],
    tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, custom[t.id] ? { ...t, custom: custom[t.id] as never } : t])),
  }
}
const run = (data: BoardData, command: Command) => {
  expect(CommandSchema.safeParse(command).success).toBe(true)
  const r = execute(data, command, { now: NOW, newId: () => 'n1', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return { data: applyChanges(data, r.changes), changes: r.changes }
}
/** Does a change worked out from a selection, and gives the board after it. */
const done = (data: BoardData, change: BulkChange) => (change.command ? run(data, change.command).data : data)

describe('a selection', () => {
  it('is the cards still on the board, in the outline’s order, and knows the subtasks that aren’t in it', () => {
    const data = board()
    const idx = indexFor(data)
    expect(stillThere(idx, new Set(['B1', 'gone', 'A2', 'A']))).toEqual(['A', 'A2', 'B1'])
    expect(theirSubtasks(idx, new Set(['A2', 'B'])).sort()).toEqual(['A2a', 'A2b', 'B1', 'B2'])
    // (One that is ticked already isn't to add, and a card's subtasks are counted once whoever is above it.)
    expect(theirSubtasks(idx, new Set(['A', 'A2', 'A2a'])).sort()).toEqual(['A1', 'A2b', 'A3', 'A4'])
    expect(withWhatIsUnder(idx, new Set(['A2', 'A2a', 'C2']))).toEqual({ cards: 3, along: 1 })
  })
})

describe('one change to several cards', () => {
  it('assigns, sets a priority and dates on the cards that would change, as one change with one undo', () => {
    const data = board()
    const idx = indexFor(data)
    const give = setOnCards(data, idx, ['A2a', 'A3', 'C1'], { assigneeId: 'ton' })
    // (Homepage is Ton's already.)
    expect(give).toMatchObject({ changed: 2, follow: 0 })
    const { data: after, changes } = run(data, give.command!)
    expect(['A2a', 'A3', 'C1'].map((id) => after.tasks[id].assigneeId)).toEqual(['ton', 'ton', 'ton'])
    expect(changes).toHaveLength(2)
    const back = run(after, { type: 'records.restore', changes: invertChanges(after, changes, NOW) }).data
    expect(['A3', 'C1'].map((id) => back.tasks[id].assigneeId)).toEqual(['mai', undefined])
    // Nobody, a priority, a due date, and clearing one.
    expect(done(data, setOnCards(data, idx, ['A2a', 'A3'], { assigneeId: null })).tasks.A3.assigneeId).toBeUndefined()
    const urgent = done(data, setOnCards(data, idx, ['A2a', 'C2'], { priority: 'urgent', due: '2026-10-20' }))
    expect([urgent.tasks.A2a.priority, urgent.tasks.C2.due]).toEqual(['urgent', '2026-10-20'])
    const cleared = setOnCards(urgent, indexFor(urgent), ['A2a', 'C2', 'A3'], { priority: null, due: '' })
    // (Deploy has a due date of its own to clear.)
    expect(cleared.changed).toBe(3)
    expect(done(urgent, cleared).tasks.C2.due).toBeUndefined()
    // Nothing to change: no command.
    expect(setOnCards(data, idx, ['A2a'], { assigneeId: 'ton' })).toEqual({ changed: 0, follow: 0 })
  })

  it('moves cards to a list at its end; where parents follow their subtasks, a parent stays and is counted', () => {
    const data = board()
    const idx = indexFor(data)
    const move = setOnCards(data, idx, ['A', 'A2', 'A2b', 'A3', 'A2a'], { status: 'doing' })
    // (Launch website and Design follow their subtasks; Homepage is in Doing already.)
    expect(move).toMatchObject({ changed: 2, follow: 0 })
    expect(setOnCards(data, idx, ['A', 'A2', 'A3'], { status: 'done' })).toMatchObject({ changed: 1, follow: 2 })
    const after = done(data, move)
    expect([after.tasks.A2b.status, after.tasks.A3.status]).toEqual(['doing', 'doing'])
    // The two arrive after the cards that were there, in the order they were named.
    const list = move.command!.type === 'tasks.update' ? move.command!.lists![0] : undefined
    expect(list).toEqual({ status: 'doing', order: [...list!.order.filter((id) => !['A2b', 'A3'].includes(id)), 'A2b', 'A3'] })
    // On a board where a parent's list is set by hand, the parent moves too.
    const manual = board({}, 'manual')
    expect(setOnCards(manual, indexFor(manual), ['A', 'A3'], { status: 'done' })).toMatchObject({ changed: 2, follow: 0 })
  })

  it('adds or removes one label, and the labels a card had besides stay', () => {
    const data = board()
    const idx = indexFor(data)
    const ids = ['A2a', 'A2b', 'A3']
    expect([...labelShares(data, ids)].map(([id, s]) => `${id} ${s.share} ${s.cards}`)).toEqual(['ui some 1', 'brand some 1', 'marketing none 0'])
    const add = labelOnCards(data, idx, ids, 'marketing', true)
    expect(add.changed).toBe(3)
    const after = done(data, add)
    expect(ids.map((id) => after.tasks[id].labels)).toEqual([['ui', 'marketing'], ['brand', 'marketing'], ['marketing']])
    expect(labelShares(after, ids).get('marketing')).toEqual({ share: 'all', cards: 3 })
    // Taking one away only touches the cards that have it.
    const take = labelOnCards(after, indexFor(after), ids, 'ui', false)
    expect(take.changed).toBe(1)
    expect(ids.map((id) => done(after, take).tasks[id].labels)).toEqual([['marketing'], ['brand', 'marketing'], ['marketing']])
    expect(labelOnCards(after, indexFor(after), ids, 'marketing', true).command).toBeUndefined()
  })

  it('sets one of the board’s fields; a field that holds several gets what was added and loses what was taken', () => {
    const data = board({ A2a: { who: ['mai', 'ton'], hours: 4 }, A2b: { who: ['mai'] }, A3: { hours: 4 } })
    const idx = indexFor(data)
    const ids = ['A2a', 'A2b', 'A3']
    // What the cards have in common: a number two of them share isn't everyone's; Mai reviews two of three.
    expect(commonValue(data, ['A2a', 'A3'], hours)).toEqual({ value: 4, mixed: false })
    expect(commonValue(data, ids, hours)).toEqual({ mixed: true })
    expect(commonValue(data, ['A2b', 'C1'], stage)).toEqual({ value: undefined, mixed: false })
    expect(commonValue(data, ['A2a', 'A2b'], reviewers)).toEqual({ value: ['mai'], mixed: true })
    expect(commonValue(data, ids, reviewers)).toEqual({ value: undefined, mixed: true })
    // A value for all, and clearing it.
    const set = done(data, fieldOnCards(data, idx, ids, hours, 8))
    expect(ids.map((id) => set.tasks[id].custom?.hours)).toEqual([8, 8, 8])
    expect(done(set, fieldOnCards(set, indexFor(set), ids, hours, null)).tasks.A3.custom?.hours).toBeUndefined()
    expect(done(data, fieldOnCards(data, idx, ids, stage, ['new'])).tasks.A3.custom?.stage).toEqual(['new'])
    // Ploy added to two cards' reviewers: each keeps who it had.
    const two = ['A2a', 'A2b']
    const added = done(data, fieldOnCards(data, idx, two, reviewers, ['mai', 'ploy'], ['mai']))
    expect(two.map((id) => added.tasks[id].custom?.who)).toEqual([
      ['mai', 'ton', 'ploy'],
      ['mai', 'ploy'],
    ])
    // Mai taken away from both: Ton stays on the one he was on, and the other holds nobody.
    const taken = done(data, fieldOnCards(data, idx, two, reviewers, [], ['mai']))
    expect(two.map((id) => taken.tasks[id].custom?.who)).toEqual([['ton'], undefined])
  })
})

describe('archiving and deleting several cards', () => {
  it('puts them away with their subtasks as one change, and one undo brings them all back', () => {
    const data = board()
    // (Design is named with Homepage, which is under it: it goes with Design.)
    const { data: after, changes } = run(data, { type: 'tasks.archive', ids: ['A2a', 'A2', 'C2'] })
    expect(Object.keys(after.archived ?? {}).sort()).toEqual(['A2', 'A2a', 'A2b', 'C2'])
    expect(['A2', 'A2a', 'A2b', 'C2'].some((id) => id in after.tasks)).toBe(false)
    const back = run(after, { type: 'records.restore', changes: invertChanges(after, changes, NOW) }).data
    expect(Object.keys(back.tasks).sort()).toEqual(Object.keys(data.tasks).sort())
    expect(back.archived?.A2).toBeUndefined()
    // As completed: unfinished ones go to the done list first.
    const fin = run(data, { type: 'tasks.archive', ids: ['A3', 'B1'], complete: true }).data
    expect([fin.archived?.A3.archivedDone, fin.archived?.B1.archivedDone]).toEqual([true, true])
  })

  it('deletes them with their subtasks and what waited on them, and refuses a card that is gone', () => {
    const start = board()
    const data = run(start, { type: 'task.update', id: 'A3', fields: { blockedBy: ['A2a', 'B1'] } }).data
    const { data: after, changes } = run(data, { type: 'tasks.delete', ids: ['A2', 'B1', 'A2b'] })
    expect(['A2', 'A2a', 'A2b', 'B1'].some((id) => id in after.tasks)).toBe(false)
    expect(after.tasks.A3.blockedBy).toEqual([])
    const back = run(after, { type: 'records.restore', changes: invertChanges(after, changes, NOW) }).data
    expect(back.tasks.A3.blockedBy).toEqual(['A2a', 'B1'])
    expect(Object.keys(back.tasks).sort()).toEqual(Object.keys(data.tasks).sort())
    const idx = indexFor(data)
    expect(execute(data, { type: 'tasks.delete', ids: ['A3', 'nope'] }, { now: NOW, newId: () => 'n', idx })).toEqual({
      error: 'That task no longer exists.',
    })
    expect(execute(data, { type: 'tasks.archive', ids: [] }, { now: NOW, newId: () => 'n', idx })).toEqual({ changes: [] })
  })
})
