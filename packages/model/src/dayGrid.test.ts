import { describe, expect, it } from 'vitest'
import { dayCards, datedCards, monthWeeks, weekRows } from './dayGrid'
import { fromDay, mondayOf, toDay } from './dates'
import { buildIndex } from './indexer'
import { defaultPrefs, prefsReducer } from './prefs'
import { makeTask } from './records'
import { ViewPrefsSchema } from './schema'
import { DEFAULT_COLUMNS, type Task } from './types'

const D = (iso: string) => toDay(iso)
const MON = D('2026-10-05') // a Monday
const index = (tasks: Partial<Task>[]) => {
  const all = tasks.map((t, i) => makeTask({ id: `t${i}`, title: `T${i}`, status: 'todo', order: `a${i}`, ...t }))
  return buildIndex(Object.fromEntries(all.map((t) => [t.id, t])), 'manual', DEFAULT_COLUMNS, [], [])
}
/** A moment on a day, at a time on this computer's clock (as someone typing a time means it). */
const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString()

describe('where a card is on the calendar', () => {
  it('is on its due day, or its start without one; from start to due when it has both; nowhere without a date', () => {
    const idx = index([
      { due: '2026-10-07' },
      { start: '2026-10-08' },
      { start: '2026-10-06', due: '2026-10-09' },
      {},
      { due: at('2026-10-07', '14:30') },
      { start: '2026-10-09', due: '2026-10-06' },
    ])
    expect(datedCards(idx, ['t0', 't1', 't2', 't3', 't4', 't5', 'gone'])).toEqual([
      { id: 't0', start: D('2026-10-07'), end: D('2026-10-07') },
      { id: 't1', start: D('2026-10-08'), end: D('2026-10-08') },
      { id: 't2', start: D('2026-10-06'), end: D('2026-10-09') },
      { id: 't4', start: D('2026-10-07'), end: D('2026-10-07'), time: '14:30' },
      // (Dates the wrong way round still make a stretch of days.)
      { id: 't5', start: D('2026-10-06'), end: D('2026-10-09') },
    ])
  })

  it('a time shows only on a card that is on one day', () => {
    const idx = index([{ start: '2026-10-06', due: at('2026-10-08', '09:00') }, { start: at('2026-10-06', '08:15') }])
    expect(datedCards(idx, ['t0', 't1']).map((c) => c.time)).toEqual([undefined, '08:15'])
  })
})

describe('weeks of days', () => {
  const card = (id: string, day: number, time?: string) => ({ id, start: MON + day, end: MON + day, ...(time && { time }) })
  const long = (id: string, from: number, to: number) => ({ id, start: MON + from, end: MON + to })

  it('each day lists its own cards: without a time first, then in time order, otherwise as given', () => {
    const [week] = weekRows([card('late', 2, '17:00'), card('b', 2), card('early', 2, '09:30'), card('a', 2), card('other', 4, '10:00')], MON, 1)
    expect(week.first).toBe(MON)
    expect(week.days[2]).toEqual(['b', 'a', 'early', 'late'])
    expect(week.days[4]).toEqual(['other'])
    expect(week.days[0]).toEqual([])
    expect(week.bars).toEqual([])
  })

  it('a card that lasts days is a bar across them, cut at the week’s ends and saying it goes on', () => {
    const rows = weekRows([long('x', 3, 9), long('y', -2, 1)], MON, 2)
    expect(rows[0].bars).toEqual([
      { id: 'y', from: 0, to: 1, lane: 0, before: true, after: false },
      { id: 'x', from: 3, to: 6, lane: 0, before: false, after: true },
    ])
    expect(rows[1].bars).toEqual([{ id: 'x', from: 0, to: 2, lane: 0, before: true, after: false }])
    expect(rows.map((r) => r.lanes)).toEqual([1, 1])
  })

  it('bars that overlap take a lane each, and a lane is used again once it is free', () => {
    const [week] = weekRows([long('a', 0, 2), long('b', 1, 3), long('c', 3, 5), long('d', 2, 6)], MON, 1)
    expect(Object.fromEntries(week.bars.map((b) => [b.id, b.lane]))).toEqual({ a: 0, b: 1, d: 2, c: 0 })
    expect(week.lanes).toBe(3)
  })

  it('one day: its own cards in time order, and the longer ones that cover it', () => {
    const all = [card('n', 2), card('t', 2, '08:00'), card('elsewhere', 3), long('span', 1, 4), long('before', -3, 1)]
    const day = dayCards(all, MON + 2)
    expect(day.cards.map((c) => c.id)).toEqual(['n', 't'])
    expect(day.long).toEqual(['span'])
    expect(dayCards(all, MON + 1).long).toEqual(['span', 'before'])
  })

  it('a month’s grid runs from the Monday on or before its first day through the week of its last', () => {
    const weeksOf = (iso: string) => {
      const m = monthWeeks(D(iso))
      return [fromDay(m.first), m.weeks]
    }
    // October 2026 starts on a Thursday and ends on a Saturday: five weeks.
    expect(weeksOf('2026-10-15')).toEqual(['2026-09-28', 5])
    // February 2027 is exactly four weeks, Monday to Sunday.
    expect(weeksOf('2027-02-10')).toEqual(['2027-02-01', 4])
    // August 2026 starts on a Saturday and needs six.
    expect(weeksOf('2026-08-31')).toEqual(['2026-07-27', 6])
    expect(mondayOf(D('2026-10-11'))).toBe(MON)
  })
})

describe('the Timeline’s own settings', () => {
  it('are kept only when they say something, and read back as saved', () => {
    const p = defaultPrefs()
    expect(prefsReducer(p, { type: 'setTimeline', config: { as: 'calendar', range: '2w', subtasks: true } }).timeline).toEqual({
      as: 'calendar',
      range: '2w',
      subtasks: true,
    })
    expect(prefsReducer(p, { type: 'setTimeline', config: { as: 'calendar', range: 'month', subtasks: false } }).timeline).toEqual({ as: 'calendar' })
    expect(prefsReducer(p, { type: 'setTimeline', config: { range: 'month' } }).timeline).toBeUndefined()
    const saved = { ...p, timeline: { as: 'calendar', range: 'week', subtasks: true } }
    expect(ViewPrefsSchema.parse(saved).timeline).toEqual(saved.timeline)
    // Settings from before there was a calendar, or with a value this version doesn't know.
    expect(ViewPrefsSchema.parse(p).timeline).toBeUndefined()
    expect(ViewPrefsSchema.parse({ ...p, timeline: { as: 'gantt', range: 'year' } }).timeline).toEqual({})
    expect(ViewPrefsSchema.parse({ ...p, timeline: 'calendar' }).timeline).toBeUndefined()
  })
})
