import { describe, expect, it } from 'vitest'
import { cleanPrefs, DEFAULT_DISPLAY, defaultPrefs, matchesPreset, prefsReducer, presetOf } from './prefs'
import { exampleData } from './sample'

describe('presets', () => {
  it('picking one copies its settings in and remembers it; the view then matches until something changes', () => {
    const saved = presetOf({ ...defaultPrefs(), filter: { labels: ['x'], due: 'week' }, outline: { density: 'compact' } })
    let p = prefsReducer({ ...defaultPrefs(), layout: 'outline' }, { type: 'applyPreset', id: 'p1', settings: saved })
    expect(p).toMatchObject({ presetId: 'p1', layout: 'outline', filter: { labels: ['x'], due: 'week' }, outline: { density: 'compact' } })
    expect(matchesPreset(p, saved)).toBe(true)
    // Key order and empty values don't count as a change.
    expect(matchesPreset({ ...p, filter: { due: 'week', labels: ['x'], statuses: [] } }, saved)).toBe(true)
    p = prefsReducer(p, { type: 'setFilter', filter: { due: 'week' } })
    expect(matchesPreset(p, saved)).toBe(false)
    expect(p.presetId).toBe('p1')
    expect(prefsReducer(p, { type: 'leavePreset' })).toMatchObject({ presetId: undefined, filter: { due: 'week' } })
  })

  it('turning presets off brings back the view from before the first one was picked', () => {
    const before = { ...defaultPrefs(), filter: { changed: 3 } }
    let p = prefsReducer(before, { type: 'applyPreset', id: 'a', settings: presetOf({ ...defaultPrefs(), filter: { due: 'week' } }) })
    p = prefsReducer(p, { type: 'applyPreset', id: 'b', settings: presetOf({ ...defaultPrefs(), filter: { due: 'overdue' } }) })
    expect(p.beforePreset?.filter).toEqual({ changed: 3 })
    p = prefsReducer(p, { type: 'leavePreset', settings: p.beforePreset })
    expect(p).toMatchObject({ filter: { changed: 3 }, presetId: undefined, beforePreset: undefined })
  })
})

describe('cleaning up', () => {
  it('forgets the card order and the folding of a list that is gone, and nothing else', () => {
    const data = exampleData('b1')
    const board = { ...DEFAULT_DISPLAY.board, listOrder: { todo: 'priority' as const, gone: 'due' as const }, collapsedColumns: ['gone', 'done'] }
    const p = cleanPrefs({ ...defaultPrefs(), display: { board } }, data)
    expect(p.display.board.listOrder).toEqual({ todo: 'priority' })
    expect(p.display.board.collapsedColumns).toEqual(['done'])
    expect(cleanPrefs(p, data)).toBe(p)
    const none = cleanPrefs({ ...defaultPrefs(), display: { board: { ...board, listOrder: { gone: 'due' as const } } } }, data)
    expect(none.display.board.listOrder).toBeUndefined()
  })
})
