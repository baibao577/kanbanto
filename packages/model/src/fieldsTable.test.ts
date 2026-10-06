import { describe, expect, it } from 'vitest'
import { todayDay, fromDay } from './dates'
import {
  fieldKey,
  fieldMatches,
  filterFromText,
  filterText,
  filterToText,
  saidFilter,
  tidyFilter,
  type BoardField,
  type CustomValues,
  type FieldFilter,
} from './fields'
import { indexFor } from './indexer'
import { cleanPrefs, defaultPrefs, matchesPreset, presetOf, type ViewPrefs } from './prefs'
import { exampleData } from './sample'
import { PresetSettingsSchema, ViewPrefsSchema } from './schema'
import { filterChips, filterCount, matchesFilter, sortComparator } from './table'
import { subtreeSums, sumOf, totalUnder } from './totals'
import type { BoardData } from './types'

const company: BoardField = { id: 'f-company', name: 'Company', type: 'text' }
const value: BoardField = { id: 'f-value', name: 'Value', type: 'number', unit: '$', decimals: 2, sum: true }
const score: BoardField = { id: 'f-score', name: 'Score', type: 'number' }
const close: BoardField = { id: 'f-close', name: 'Close date', type: 'date' }
const stage: BoardField = {
  id: 'f-stage',
  name: 'Stage',
  type: 'choice',
  options: [
    { id: 'lead', name: 'Lead', color: 'gray' },
    { id: 'won', name: 'Won', color: 'green' },
  ],
}
const signed: BoardField = { id: 'f-signed', name: 'Signed', type: 'checkbox' }
const FIELDS = [company, value, score, close, stage, signed]
const today = todayDay()

/** The example board with these fields, and values on some cards (A2 has subtasks A2a and A2b). */
function board(values: Record<string, CustomValues>): BoardData {
  const data = exampleData('b1')
  return {
    ...data,
    fields: FIELDS,
    tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, values[t.id] ? { ...t, custom: values[t.id] } : t])),
  }
}

describe('sorting the Outline by a field', () => {
  const data = board({
    A1: { 'f-company': 'beta', 'f-score': 10, 'f-stage': ['won'], 'f-signed': true, 'f-close': fromDay(today + 3) },
    A3: { 'f-company': 'Acme', 'f-score': 2, 'f-stage': ['lead'], 'f-close': fromDay(today - 2) },
    A4: { 'f-stage': ['gone'] },
  })
  const idx = indexFor(data)
  const sorted = (field: BoardField, dir: 'asc' | 'desc') => ['A1', 'A3', 'A4'].sort(sortComparator(idx, { key: fieldKey(field.id), dir }, new Map()))

  it('orders each kind its own way, with nothing always last', () => {
    expect(sorted(company, 'asc')).toEqual(['A3', 'A1', 'A4'])
    expect(sorted(company, 'desc')).toEqual(['A1', 'A3', 'A4'])
    expect(sorted(score, 'asc')).toEqual(['A3', 'A1', 'A4'])
    expect(sorted(score, 'desc')).toEqual(['A1', 'A3', 'A4'])
    expect(sorted(close, 'asc')).toEqual(['A3', 'A1', 'A4'])
    // By the options' order; an option that's gone counts as none.
    expect(sorted(stage, 'asc')).toEqual(['A3', 'A1', 'A4'])
    expect(sorted(stage, 'desc')).toEqual(['A1', 'A3', 'A4'])
  })

  it('a checkbox has two real values: ticked first, or last', () => {
    expect(sorted(signed, 'asc')[0]).toBe('A1')
    expect(sorted(signed, 'desc').at(-1)).toBe('A1')
  })

  it('a field that left the board leaves the order alone', () => {
    expect(['A4', 'A1', 'A3'].sort(sortComparator(idx, { key: 'f:nope', dir: 'asc' }, new Map()))).toEqual(['A4', 'A1', 'A3'])
  })
})

describe('totals', () => {
  it('add up to the field’s decimals, and never read "-0"', () => {
    expect(sumOf({ decimals: 2 }, [0.1, 0.2])).toBe(0.3)
    expect(sumOf({}, [0.1, 0.2])).toBe(0.3)
    expect(Object.is(sumOf({ decimals: 2 }, [0.1, 0.2, -0.3]), 0)).toBe(true)
    expect(sumOf({ decimals: 0 }, [])).toBe(0)
  })

  it('a card’s total is its own number plus its subtasks’, counted once each', () => {
    const data = board({ A: { 'f-value': 1 }, A2: { 'f-value': 10 }, A2a: { 'f-value': 100 }, A2b: { 'f-value': 0.5 }, B1: { 'f-value': 7 } })
    const idx = indexFor(data)
    const sums = subtreeSums(idx, value)
    expect(sums.get('A2')).toBe(110.5)
    expect(sums.get('A')).toBe(111.5)
    expect(sums.get('B')).toBe(7)
    expect(sums.has('C')).toBe(false)
    // Only the cards a filter keeps: a parent's total then agrees with what's shown under it.
    expect(subtreeSums(idx, value, new Set(['A2a', 'A'])).get('A')).toBe(101)
    expect(subtreeSums(idx, value, new Set(['B'])).has('B')).toBe(false)
    // One card's total, as its dialog says it, agrees; none when there's no number at or under it.
    for (const id of ['A', 'A2', 'A2a', 'B']) expect(totalUnder(idx, value, id)).toBe(sums.get(id))
    expect(totalUnder(idx, value, 'C')).toBeUndefined()
    // Sorted by what a row is worth: its own number plus its subtasks'.
    const rows = ['A', 'B', 'C'].sort(sortComparator(idx, { key: fieldKey(value.id), dir: 'desc' }, new Map()))
    expect(rows).toEqual(['A', 'B', 'C'])
    expect(['C', 'A', 'B'].sort(sortComparator(idx, { key: fieldKey(value.id), dir: 'asc' }, new Map()))).toEqual(['B', 'A', 'C'])
  })
})

describe('filtering by a field', () => {
  const pass = (def: BoardField, v: CustomValues[string] | undefined, f: FieldFilter) => fieldMatches(def, v, f, { today })

  it('asks each kind what it can answer', () => {
    expect([pass(stage, ['won'], { in: ['won', 'lead'] }), pass(stage, ['lead'], { in: ['won'] })]).toEqual([true, false])
    expect([pass(stage, undefined, { in: [''] }), pass(stage, undefined, { in: ['won'] }), pass(stage, ['won'], { in: [''] })]).toEqual([
      true,
      false,
      false,
    ])
    expect([pass(signed, true, { checked: true }), pass(signed, undefined, { checked: true }), pass(signed, undefined, { checked: false })]).toEqual([
      true,
      false,
      true,
    ])
    // From nothing up: zero is a real limit, and a card without a number is never "in range".
    expect([pass(score, 0, { min: 0 }), pass(score, -1, { min: 0 }), pass(score, undefined, { min: 0 })]).toEqual([true, false, false])
    expect([pass(score, 5, { min: 1, max: 5 }), pass(score, 6, { max: 5 })]).toEqual([true, false])
    expect([pass(score, undefined, { has: false }), pass(score, 3, { has: false }), pass(company, 'x', { has: true })]).toEqual([true, false, true])
    expect([
      pass(close, fromDay(today - 1), { date: 'past' }),
      pass(close, fromDay(today), { date: 'past' }),
      pass(close, undefined, { date: 'past' }),
    ]).toEqual([true, false, false])
    expect([pass(close, fromDay(today + 7), { date: 'week' }), pass(close, fromDay(today + 8), { date: 'week' })]).toEqual([true, false])
    expect([pass(close, undefined, { date: 'none' }), pass(close, fromDay(today), { date: 'none' })]).toEqual([true, false])
    // A part that isn't for the kind says nothing.
    expect(pass(company, 'x', { min: 5, checked: true })).toBe(true)
  })

  it('on a board: counted, matched, and said in words', () => {
    const data = board({ A1: { 'f-stage': ['won'], 'f-score': 3 }, A3: { 'f-stage': ['lead'] } })
    const idx = indexFor(data)
    const f = { statuses: ['todo'], fields: { 'f-stage': { in: ['won', ''] }, 'f-score': { min: 0 } } }
    expect(filterCount(f)).toBe(3)
    expect(matchesFilter(idx, 'A1', { fields: f.fields })).toBe(true)
    expect(matchesFilter(idx, 'A3', { fields: f.fields })).toBe(false)
    expect(matchesFilter(idx, 'A4', { fields: { 'f-stage': { in: [''] } } })).toBe(true)
    // (A filter for a field that isn't on the board keeps nothing out.)
    expect(matchesFilter(idx, 'A3', { fields: { 'f-left': { in: ['x'] } } })).toBe(true)
    expect(filterChips(f, data.columns, data.labels, data.members, data.fields).slice(1)).toEqual([
      { key: 'fields', field: 'f-stage', label: 'Stage:', value: 'Won, none' },
      { key: 'fields', field: 'f-score', label: 'Score:', value: '0 or more' },
    ])
    expect(filterText(value, { min: 1000, max: 5000 })).toBe('$1,000.00 to $5,000.00')
    expect([filterText(signed, { checked: false }), filterText(close, { date: 'week' }), filterText(company, { has: false })]).toEqual([
      'no',
      'in the next 7 days',
      'empty',
    ])
  })

  it('a filter keeps what its field can still use, and comes back as it was when nothing had to go', () => {
    const fine: FieldFilter = { in: ['won', ''] }
    expect(tidyFilter(stage, fine)).toBe(fine)
    expect(tidyFilter(stage, { in: ['won', 'gone'] })).toEqual({ in: ['won'] })
    expect(tidyFilter(stage, { in: ['gone'] })).toBeUndefined()
    expect(tidyFilter(stage, { in: ['won'], min: 3 })).toEqual({ in: ['won'] })
    expect(tidyFilter(score, { min: 0 })).toEqual({ min: 0 })
    expect(tidyFilter(signed, { checked: false })).toEqual({ checked: false })
    expect(tidyFilter(company, {})).toBeUndefined()
  })

  it('goes into an address and comes back', () => {
    const round = (def: BoardField, f: FieldFilter) => filterFromText(def, filterToText(def, f))
    expect(filterToText(stage, { in: ['won', ''] })).toBe('won,-')
    expect(round(stage, { in: ['won', ''] })).toEqual({ in: ['won', ''] })
    expect(round(signed, { checked: false })).toEqual({ checked: false })
    expect(round(company, { has: true })).toEqual({ has: true })
    expect(round(close, { date: 'past' })).toEqual({ date: 'past' })
    expect([filterToText(score, { min: 10 }), round(score, { min: 10, max: 200 })]).toEqual(['10..', { min: 10, max: 200 }])
    expect([filterFromText(stage, 'gone'), filterFromText(signed, 'maybe'), filterFromText(score, '')]).toEqual([undefined, undefined, undefined])
  })

  it('what an assistant says to look for is read forgivingly', () => {
    const find = (def: BoardField, said: string | number | boolean | null, v: CustomValues[string] | undefined) => {
      const r = saidFilter(def, said)
      return 'error' in r ? r.error : r.test(v)
    }
    expect([find(company, 'ACME', 'Acme'), find(company, null, undefined), find(company, null, 'Acme')]).toEqual([true, true, false])
    expect([find(score, '1,200', 1200), find(score, 5, 6), find(score, 'lots', 1)]).toEqual([true, false, 'Score: that isn’t a number.'])
    expect([find(stage, 'won', ['won']), find(stage, 'Lost', ['won'])]).toEqual([
      true,
      'There’s no option “Lost” for Stage. The options are: Lead, Won.',
    ])
    expect([find(signed, true, true), find(signed, 'no', undefined), find(signed, false, true)]).toEqual([true, true, false])
    // A day finds a date on that day, with a time or without.
    expect([
      find(close, '2026-10-31', '2026-10-31'),
      find(close, '2026-10-31', '2026-10-31T07:30:00Z'),
      find(close, '2026-10-30', '2026-10-31'),
    ]).toEqual([true, true, false])
    // An archived option can still be looked for.
    expect(find({ ...stage, options: [{ id: 'old', name: 'Parked', color: 'amber', archived: true }] }, 'parked', ['old'])).toBe(true)
  })
})

describe('view settings that name a field', () => {
  const data = board({})
  const prefs = (over: Partial<ViewPrefs>): ViewPrefs => ({ ...defaultPrefs(), ...over })

  it('are saved and read back whole', () => {
    const p = prefs({
      outline: { sort: { key: 'f:f-stage', dir: 'desc' }, hidden: ['due', 'f:f-score'], hideFields: true },
      filter: { fields: { 'f-stage': { in: ['won', ''] }, 'f-score': { min: 0 }, 'f-signed': { checked: false } } },
    })
    expect(ViewPrefsSchema.parse(p)).toEqual(p)
    expect(PresetSettingsSchema.parse(presetOf(p))).toEqual(presetOf(p))
    expect(PresetSettingsSchema.safeParse({ ...presetOf(p), outline: { sort: { key: 'f:', dir: 'asc' } } }).success).toBe(false)
    expect(PresetSettingsSchema.safeParse({ ...presetOf(p), outline: { sort: { key: 'nope', dir: 'asc' } } }).success).toBe(false)
  })

  it('are cleaned when the field or an option is gone, and left exactly alone otherwise', () => {
    const fine = prefs({
      outline: { sort: { key: 'f:f-stage', dir: 'asc' }, hidden: ['due', 'f:f-score'] },
      filter: { fields: { 'f-stage': { in: ['won'] }, 'f-score': { min: 0 } } },
    })
    expect(cleanPrefs(fine, data)).toBe(fine)

    const stale = prefs({
      outline: { sort: { key: 'f:f-left', dir: 'asc' }, hidden: ['due', 'f:f-left', 'f:f-score'] },
      filter: { fields: { 'f-left': { in: ['x'] }, 'f-stage': { in: ['won', 'gone'] }, 'f-signed': { min: 3 } } },
    })
    const cleaned = cleanPrefs(stale, data)
    expect(cleaned.outline).toEqual({ sort: undefined, hidden: ['due', 'f:f-score'] })
    expect(cleaned.filter.fields).toEqual({ 'f-stage': { in: ['won'] } })
    // Cleaning again changes nothing (it runs on every change: it mustn't keep making new settings).
    expect(cleanPrefs(cleaned, data)).toBe(cleaned)
    // With no filter left there's no `fields` at all, so a preset without one still reads as unchanged.
    const none = cleanPrefs(prefs({ filter: { fields: { 'f-left': { in: ['x'] } } } }), data)
    expect(none.filter.fields).toBeUndefined()
    expect(matchesPreset(none, presetOf(defaultPrefs()))).toBe(true)
  })
})
