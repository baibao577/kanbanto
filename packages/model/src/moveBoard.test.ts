import { describe, expect, it } from 'vitest'
import { applyChanges } from './changes'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import { emptyBoard, exampleData } from './sample'
import type { Task } from './types'

const now = '2026-10-01T00:00:00.000Z'
let n = 0
const ctx = { now, newId: () => `n${++n}` }

describe('moving a task to another board', () => {
  it('takes its subtasks, matches lists and labels, and keeps only people who are there', () => {
    const source = { ...exampleData('src', 'ann'), members: [{ id: 'ann', name: 'Ann', createdAt: now, updatedAt: now, version: 1 }] }
    const target = { ...emptyBoard('dst', 'Home', now), members: [] }
    // A1 waits on nothing; give A2a a link to a task that stays behind.
    source.tasks.A2a = { ...source.tasks.A2a, blockedBy: ['B1'] }
    source.tasks.A2b = { ...source.tasks.A2b, assigneeId: 'ann' }
    const plan = planMove(source, target, 'A2', {}, ctx)
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.summary).toMatchObject({ title: source.tasks.A2.title, subtasks: 2, droppedLinks: 1 })
    // Ann isn't on the other board: her tasks there are unassigned.
    expect(plan.summary.unassigned).toEqual(['Ann'])
    expect(applyChanges(target, plan.target).tasks[plan.ids.get('A2b')!].assigneeId).toBeUndefined()

    // Gone from the source, with everything under it.
    const left = applyChanges(source, plan.source)
    expect(left.tasks.A2).toBeUndefined()
    expect(left.tasks.A2a).toBeUndefined()

    // On the target: new ids, the same tree, lists by name, labels added.
    const moved = applyChanges(target, plan.target)
    const root = moved.tasks[plan.ids.get('A2')!]
    expect(root.parentId).toBe(null)
    const kids = Object.values(moved.tasks).filter((t: Task) => t.parentId === root.id)
    expect(kids).toHaveLength(2)
    const byName = (id: string) => moved.columns.find((c) => c.id === id)!.name
    for (const old of ['A2a', 'A2b']) {
      const t = moved.tasks[plan.ids.get(old)!]
      expect(byName(t.status)).toBe(source.columns.find((c) => c.id === source.tasks[old].status)!.name)
      expect(t.blockedBy).toEqual([])
    }
    expect(plan.summary.newLabels.length).toBe(moved.labels.length)
    expect(indexFor(moved).roots).toEqual([root.id])
  })

  it('puts what isn’t done in the chosen list, under a chosen parent; refuses a list from elsewhere', () => {
    const ann = { id: 'ann', name: 'Ann', createdAt: now, updatedAt: now, version: 1 }
    const source = { ...exampleData('src', 'ann'), members: [ann] }
    const target = { ...exampleData('dst', 'ann'), members: [ann] }
    const plan = planMove(source, target, 'A', { status: 'backlog', parentId: 'B' }, ctx)
    if ('error' in plan) throw new Error(plan.error)
    const moved = applyChanges(target, plan.target)
    const root = moved.tasks[plan.ids.get('A')!]
    expect(root.parentId).toBe('B')
    expect(moved.tasks[plan.ids.get('A1')!].status).toBe('done')
    expect(moved.tasks[plan.ids.get('A3')!].status).toBe('backlog')
    // The same people are on both boards, so no one is unassigned.
    expect(plan.summary.unassigned).toEqual([])
    expect(planMove(source, target, 'A', { status: 'nope' }, ctx)).toEqual({ error: 'That list isn’t on the other board.' })
    expect(planMove(source, source, 'A', {}, ctx)).toEqual({ error: 'It’s already on this board.' })
  })

  it('lands where it was dropped: at a place in the list, in exactly that list', () => {
    const source = exampleData('src', 'ann')
    const base = emptyBoard('dst', 'Home', now)
    const card = (id: string, rank?: string): Task => ({ ...source.tasks.B1, id, parentId: null, status: 'todo', labels: [], blockedBy: [], rank })
    const order = (data: typeof base, list: string) => {
      const idx = indexFor(data)
      return Object.values(data.tasks)
        .filter((t) => t.parentId === null && t.status === list)
        .sort((a, b) => (a.rank! < b.rank! ? -1 : 1))
        .map((t) => (idx.roots.includes(t.id) ? t.id : ''))
    }

    // A list ordered by hand: only the card that arrives gets a position, between its neighbours.
    const ranked = { ...base, tasks: { x: card('x', 'a0'), y: card('y', 'a1'), z: card('z', 'a2') } }
    const mid = planMove(source, ranked, 'B1', { status: 'todo', order: { ids: ['x', 'y', 'z'], at: 1 } }, ctx)
    if ('error' in mid) throw new Error(mid.error)
    expect(mid.target.map((c) => c.id)).toEqual([mid.ids.get('B1')])
    expect(order(applyChanges(ranked, mid.target), 'todo')).toEqual(['x', mid.ids.get('B1'), 'y', 'z'])
    // First, last, and a place past the end (or cards that have since gone): as near as it can be.
    for (const [at, want] of [
      [0, 0],
      [3, 3],
      [99, 3],
    ]) {
      const p = planMove(source, ranked, 'B1', { status: 'todo', order: { ids: ['x', 'gone', 'y', 'z'], at: at === 0 ? 0 : at + 1 } }, ctx)
      if ('error' in p) throw new Error(p.error)
      expect(order(applyChanges(ranked, p.target), 'todo').indexOf(p.ids.get('B1')!)).toBe(want)
    }

    // A list nobody ordered yet: all of it gets positions, in the order it was showing.
    const plain = { ...base, tasks: { x: card('x'), y: card('y') } }
    const first = planMove(source, plain, 'B1', { status: 'todo', order: { ids: ['y', 'x'], at: 1 } }, ctx)
    if ('error' in first) throw new Error(first.error)
    expect(order(applyChanges(plain, first.target), 'todo')).toEqual(['y', first.ids.get('B1'), 'x'])
    expect(applyChanges(plain, first.target).tasks.x.version).toBe(source.tasks.B1.version + 1)

    // A done card goes to the list it was dropped on (its done subtasks stay done); without a place, to a done list.
    const done = { ...source, tasks: { ...source.tasks, A: { ...source.tasks.A, status: 'done' } } }
    const dropped = planMove(done, ranked, 'A', { status: 'todo', order: { ids: ['x', 'y', 'z'], at: 3 } }, ctx)
    if ('error' in dropped) throw new Error(dropped.error)
    const after = applyChanges(ranked, dropped.target)
    expect(after.tasks[dropped.ids.get('A')!]).toMatchObject({ status: 'todo' })
    expect(after.tasks[dropped.ids.get('A')!].doneAt).toBeUndefined()
    expect(after.tasks[dropped.ids.get('A1')!].status).toBe('done')
    const chosen = planMove(done, ranked, 'A', { status: 'todo' }, ctx)
    if ('error' in chosen) throw new Error(chosen.error)
    expect(applyChanges(ranked, chosen.target).tasks[chosen.ids.get('A')!]).toMatchObject({ status: 'done' })
    expect(applyChanges(ranked, chosen.target).tasks[chosen.ids.get('A')!].rank).toBeUndefined()
  })
})
