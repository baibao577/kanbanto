import { describe, expect, it } from 'vitest'
import { archivedDoneAt, archivedFamily, archivedIn } from './archived'
import type { Task, TaskMap } from './types'

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T10:00:00.000Z`
const ms = (n: number) => Date.parse(day(n))

/** An archived task: made, maybe done, and archived on days of September. */
function put(id: string, parentId: string | null, made: number, archived: number, done?: number): Task {
  return {
    id,
    title: id,
    parentId,
    status: 'done',
    order: id,
    labels: [],
    blockedBy: [],
    createdAt: day(made),
    updatedAt: day(archived),
    version: 2,
    archivedAt: day(archived),
    archivedList: 'Done',
    archivedDone: done !== undefined,
    ...(done !== undefined && { doneAt: day(done) }),
  }
}
const map = (...ts: Task[]): TaskMap => Object.fromEntries(ts.map((t) => [t.id, t]))

const archived = map(
  put('P', null, 1, 20, 10),
  put('P1', 'P', 2, 20, 5),
  put('P1a', 'P1', 3, 20, 4),
  put('P2', 'P', 2, 20, 10),
  put('lone', null, 12, 25, 15),
  put('unfinished', null, 18, 28),
  // Archived on its own while its parent stayed on the board.
  put('stray', 'on-board', 6, 8, 7),
)

describe('an archived task with its family', () => {
  it('gives the archived tasks above it, itself, and everything archived under it', () => {
    expect(archivedFamily(archived, 'P1').map((t) => t.id)).toEqual(['P', 'P1', 'P1a'])
    expect(
      archivedFamily(archived, 'P')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['P', 'P1', 'P1a', 'P2'])
    expect(archivedFamily(archived, 'P1a').map((t) => t.id)).toEqual(['P', 'P1', 'P1a'])
  })

  it('a parent that isn’t archived isn’t part of it; an unknown task has no family', () => {
    expect(archivedFamily(archived, 'stray').map((t) => t.id)).toEqual(['stray'])
    expect(archivedFamily(archived, 'nope')).toEqual([])
  })

  it('parents that point at each other don’t loop', () => {
    const loop = map(put('a', 'b', 1, 2), put('b', 'a', 1, 2))
    expect(
      archivedFamily(loop, 'a')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })
})

describe('archived tasks in a stretch of time', () => {
  const ids = (q: Parameters<typeof archivedIn>[1]) => archivedIn(archived, q).map((t) => t.id)

  it('without a range: all of them, the latest archived first', () => {
    expect(ids({})).toEqual(['unfinished', 'lone', 'P', 'P1', 'P1a', 'P2', 'stray'])
  })

  it('by when they were archived (the default): from a moment up to, not including, another', () => {
    expect(ids({ from: ms(20), to: ms(28) })).toEqual(['lone', 'P', 'P1', 'P1a', 'P2'])
    expect(ids({ from: ms(26) })).toEqual(['unfinished'])
    expect(ids({ to: ms(20) })).toEqual(['stray'])
  })

  it('by when they got done: only ones archived as completed, newest done first', () => {
    expect(ids({ when: 'done', from: ms(5), to: ms(11) })).toEqual(['P', 'P2', 'stray', 'P1'])
    expect(ids({ when: 'done' })).not.toContain('unfinished')
  })

  it('by when they were made', () => {
    expect(ids({ when: 'created', from: ms(12) })).toEqual(['unfinished', 'lone'])
  })

  it('any: whichever date falls in the range, placed by the latest one that does', () => {
    // Made on the 18th and archived on the 28th: both in range, so it sorts by the 28th.
    expect(ids({ when: 'any', from: ms(15), to: ms(29) })).toEqual(['unfinished', 'lone', 'P', 'P1', 'P1a', 'P2'])
    // Only "stray" has anything on the 6th to the 8th.
    expect(ids({ when: 'any', from: ms(6), to: ms(9) })).toEqual(['stray'])
  })

  it('a completed card without a done moment counts as done when it was archived', () => {
    const { doneAt: _none, ...old } = put('old', null, 1, 9, 2)
    expect(archivedDoneAt(old)).toBe(ms(9))
    expect(archivedDoneAt(archived.unfinished)).toBeNull()
  })
})
