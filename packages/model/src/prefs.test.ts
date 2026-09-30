import { describe, expect, it } from 'vitest'
import { defaultPrefs, matchesPreset, prefsReducer, presetOf } from './prefs'

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
    const before = { ...defaultPrefs(), filter: { upNext: true } }
    let p = prefsReducer(before, { type: 'applyPreset', id: 'a', settings: presetOf({ ...defaultPrefs(), filter: { due: 'week' } }) })
    p = prefsReducer(p, { type: 'applyPreset', id: 'b', settings: presetOf({ ...defaultPrefs(), filter: { due: 'overdue' } }) })
    expect(p.beforePreset?.filter).toEqual({ upNext: true })
    p = prefsReducer(p, { type: 'leavePreset', settings: p.beforePreset })
    expect(p).toMatchObject({ filter: { upNext: true }, presetId: undefined, beforePreset: undefined })
  })
})
