import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { boards } from '../src/db/schema'
import { Person, reset, setup } from './helpers'

// Every time a board is read whole from the database is noted, to tell a board served from memory from one that wasn't.
const loaded = vi.hoisted(() => ({ boards: [] as string[] }))
vi.mock('../src/boards/store', async (original) => {
  const real = await original<typeof import('../src/boards/store')>()
  const loadBoard: typeof real.loadBoard = (tx, boardId) => {
    loaded.boards.push(boardId)
    return real.loadBoard(tx, boardId)
  }
  return { ...real, loadBoard }
})

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

describe('reading a board from the database', () => {
  it('happens once for everyone who asks at the same moment, and again after the next change', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Shared', template: 'example' })
    // Changed some other way (a field renamed, say): what's in memory is out of date, and everyone with it open asks.
    const changedElsewhere = () =>
      t.db
        .update(boards)
        .set({ seq: sql`${boards.seq} + 1` })
        .where(eq(boards.id, id))
    await changedElsewhere()
    loaded.boards = []
    const answers = await Promise.all(Array.from({ length: 8 }, () => ann.ok('GET', `/api/boards/${id}`)))
    expect(loaded.boards).toEqual([id])
    expect(new Set(answers.map((a) => JSON.stringify(a.data.tasks))).size).toBe(1)
    expect(Object.keys(answers[0].data.tasks).length).toBeGreaterThan(5)
    // From memory after that.
    await ann.ok('GET', `/api/boards/${id}`)
    expect(loaded.boards).toEqual([id])
    // Another change: read again, once.
    await changedElsewhere()
    await Promise.all([ann.ok('GET', `/api/boards/${id}`), ann.ok('GET', `/api/boards/${id}`)])
    expect(loaded.boards).toEqual([id, id])
  })

  it('a board that’s gone is said to be gone, to each one asking', async () => {
    const ann = await Person.signUp(t.app, 'Ann')
    const { id } = await ann.ok('POST', '/api/boards', { name: 'Short-lived' })
    await ann.ok('DELETE', `/api/boards/${id}`)
    const answers = await Promise.all([ann.request('GET', `/api/boards/${id}`), ann.request('GET', `/api/boards/${id}`)])
    expect(answers.map((a) => a.status)).toEqual([404, 404])
  })
})
