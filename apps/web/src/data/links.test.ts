import { describe, expect, it, vi } from 'vitest'
import { linkRef } from '@kanbanto/model/fields'
import { exampleData } from '@kanbanto/model/sample'
import { LinkStore } from './links'

const HERE = '01900000-0000-7000-8000-00000000000a'
const THERE = '01900000-0000-7000-8000-00000000000b'
const acme = linkRef(THERE, 'c1')
const card = { title: 'Acme', board: { id: THERE, name: 'Companies' }, list: 'To Do', kind: 'todo' as const, done: false }

describe('what links point at, in the browser', () => {
  it('tells only the chips whose card changed, and gives the same answer as the same object', () => {
    const store = new LinkStore(HERE)
    const one = vi.fn()
    const other = vi.fn()
    store.learn({ [acme]: card })
    store.subscribe(acme, one)
    store.subscribe(linkRef(THERE, 'c2'), other)
    expect(store.get(acme)).toBe(store.get(acme))
    expect(store.titleOf(acme)).toBe('Acme')
    // The same card learned again changes nothing; a new title tells its chip, and not the other one.
    const before = store.getVersion()
    store.learn({ [acme]: { ...card } })
    expect(one).not.toHaveBeenCalled()
    expect(store.getVersion()).toBe(before)
    store.learn({ [acme]: { ...card, title: 'Acme Ltd' } })
    expect(one).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    expect(store.titleOf(acme)).toBe('Acme Ltd')
    expect(store.getVersion()).toBeGreaterThan(before)
  })

  it('reads a card of the board itself from the board, live', () => {
    const store = new LinkStore(HERE)
    const data = exampleData(HERE)
    const here = linkRef(HERE, 'A3')
    const told = vi.fn()
    store.see(data)
    store.subscribe(here, told)
    expect(store.get(here)).toMatchObject({ title: 'Deploy', list: 'To Do', kind: 'todo', done: false })
    expect(store.get(here)).toBe(store.get(here))
    // Renamed on the board: its chip is told, and reads the new title.
    store.see({ ...data, tasks: { ...data.tasks, A3: { ...data.tasks.A3, title: 'Ship it' } } })
    expect(told).toHaveBeenCalled()
    expect(store.titleOf(here)).toBe('Ship it')
    // Gone from the board's active cards: what the server said about it (archived, deleted) is used instead.
    const { A3: _gone, ...rest } = data.tasks
    store.learn({ [here]: { gone: true } })
    store.see({ ...data, tasks: rest })
    expect(store.get(here)).toEqual({ gone: true })
    expect(store.titleOf(here)).toBeUndefined()
  })
})
