import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  dateMatches,
  dateTestFromText,
  dateTestText,
  dateTestToText,
  dayIn,
  dayNumberIn,
  shortDay,
  tidyDateTest,
  toDay,
  type DateTest,
} from './dates'
import { fieldMatches, filterFromText, filterText, filterToText, ME, tidyFilter, type BoardField, type FieldFilter, type FieldMap } from './fields'
import { indexFor } from './indexer'
import { cleanPrefs, defaultPrefs, matchesPreset, presetOf, remapPreset, type ViewPrefs } from './prefs'
import { exampleData } from './sample'
import { PresetSettingsSchema, ViewPrefsSchema } from './schema'
import { matchesCard, type CardFacts } from './search'
import { arrangeColumns, dueChoiceOf, dueFromText, dueText, dueToText, filterChips, filterCount, matchesFilter, moveColumn, withDue } from './table'
import type { BoardData, Task } from './types'
import { matcher } from './view'

// A Tuesday: its week is 5 to 11 October, its month October.
const TODAY = toDay('2026-10-06')
const HERE = '01900000-0000-7000-8000-00000000000a'

const company: BoardField = { id: 'f-company', name: 'Company', type: 'text' }
const value: BoardField = { id: 'f-value', name: 'Value', type: 'number', unit: '$', decimals: 2, sum: true }
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
const account: BoardField = { id: 'f-account', name: 'Account', type: 'link', many: true }
const reviewer: BoardField = { id: 'f-reviewer', name: 'Reviewer', type: 'person', many: true }
const FIELDS = [company, value, close, stage, signed, account, reviewer]

/** The example board with these fields, and what's given changed on some cards. */
function board(over: Record<string, Partial<Task>>): BoardData {
  const data = exampleData('b1')
  return { ...data, fields: FIELDS, tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, { ...t, ...over[t.id] }])) }
}

describe('a test of a day', () => {
  const on = (day: string | undefined, t: DateTest, today = TODAY) => dateMatches(day === undefined ? undefined : toDay(day), t, today)
  const edges = (t: DateTest, inside: [string, string], outside: [string, string]) =>
    expect([on(inside[0], t), on(inside[1], t), on(outside[0], t), on(outside[1], t)]).toEqual([true, true, false, false])

  it('a day, a week from Monday to Sunday, a month: each to its first and last day', () => {
    edges({ on: 'today' }, ['2026-10-06', '2026-10-06'], ['2026-10-05', '2026-10-07'])
    edges({ on: 'tomorrow' }, ['2026-10-07', '2026-10-07'], ['2026-10-06', '2026-10-08'])
    edges({ on: 'yesterday' }, ['2026-10-05', '2026-10-05'], ['2026-10-04', '2026-10-06'])
    edges({ on: 'this-week' }, ['2026-10-05', '2026-10-11'], ['2026-10-04', '2026-10-12'])
    edges({ on: 'next-week' }, ['2026-10-12', '2026-10-18'], ['2026-10-11', '2026-10-19'])
    edges({ on: 'last-week' }, ['2026-09-28', '2026-10-04'], ['2026-09-27', '2026-10-05'])
    edges({ on: 'this-month' }, ['2026-10-01', '2026-10-31'], ['2026-09-30', '2026-11-01'])
    edges({ on: 'next-month' }, ['2026-11-01', '2026-11-30'], ['2026-10-31', '2026-12-01'])
    edges({ on: 'last-month' }, ['2026-09-01', '2026-09-30'], ['2026-08-31', '2026-10-01'])
  })

  it('months across a new year', () => {
    const december = toDay('2026-12-15')
    expect([on('2027-01-01', { on: 'next-month' }, december), on('2027-01-31', { on: 'next-month' }, december)]).toEqual([true, true])
    expect([on('2026-12-31', { on: 'next-month' }, december), on('2027-02-01', { on: 'next-month' }, december)]).toEqual([false, false])
    const january = toDay('2027-01-10')
    expect([on('2026-12-01', { on: 'last-month' }, january), on('2026-12-31', { on: 'last-month' }, january)]).toEqual([true, true])
    expect([on('2026-11-30', { on: 'last-month' }, january), on('2027-01-01', { on: 'last-month' }, january)]).toEqual([false, false])
  })

  it('before and after today, the next and the last so many days (today counts), and days given outright', () => {
    edges({ on: 'past' }, ['2026-10-05', '2020-01-01'], ['2026-10-06', '2026-10-07'])
    edges({ on: 'future' }, ['2026-10-07', '2030-01-01'], ['2026-10-06', '2026-10-05'])
    edges({ on: 'next', days: 30 }, ['2026-10-06', '2026-11-05'], ['2026-10-05', '2026-11-06'])
    edges({ on: 'last', days: 7 }, ['2026-09-29', '2026-10-06'], ['2026-09-28', '2026-10-07'])
    edges({ from: '2026-10-01', to: '2026-10-31' }, ['2026-10-01', '2026-10-31'], ['2026-09-30', '2026-11-01'])
    edges({ from: '2026-10-01' }, ['2026-10-01', '2030-01-01'], ['2026-09-30', '2020-01-01'])
    edges({ to: '2026-10-31' }, ['2026-10-31', '2020-01-01'], ['2026-11-01', '2030-01-01'])
  })

  it('no date at all: only "no date" is passed, and a test that asks nothing hides nothing', () => {
    expect([on(undefined, { on: 'none' }), on('2026-10-06', { on: 'none' })]).toEqual([true, false])
    expect([on(undefined, { on: 'any' }), on('2026-10-06', { on: 'any' })]).toEqual([false, true])
    expect([on(undefined, { on: 'today' }), on(undefined, { on: 'past' }), on(undefined, { from: '2026-01-01' })]).toEqual([false, false, false])
    expect([on(undefined, {}), on('2026-10-06', {})]).toEqual([true, true])
  })

  it('is kept to what means something, and left exactly alone when it does', () => {
    for (const fine of [{ on: 'today' }, { on: 'next', days: 7 }, { from: '2026-10-01', to: '2026-10-31' }, { to: '2026-10-31' }] as DateTest[])
      expect(tidyDateTest(fine)).toBe(fine)
    expect(tidyDateTest({ on: 'next' })).toBeUndefined()
    expect(tidyDateTest({ on: 'last', days: 0 })).toBeUndefined()
    expect(tidyDateTest({ on: 'next', days: 2.5 })).toBeUndefined()
    expect(tidyDateTest({ on: 'today', days: 3, from: '2026-10-01' })).toEqual({ on: 'today' })
    expect(tidyDateTest({ from: 'soon' })).toBeUndefined()
    expect(tidyDateTest({ from: '2026-02-30' })).toBeUndefined()
    expect(tidyDateTest({ on: 'someday' as never, to: '2026-10-01' })).toEqual({ to: '2026-10-01' })
    expect(tidyDateTest({})).toBeUndefined()
  })

  it('in words, and as text for an address and back', () => {
    expect(dateTestText({ on: 'this-month' })).toBe('this month')
    expect([dateTestText({ on: 'next', days: 30 }), dateTestText({ on: 'last', days: 1 })]).toEqual(['in the next 30 days', 'in the last day'])
    expect(dateTestText({ from: '2026-10-01', to: '2026-10-31' }, TODAY)).toBe('from 1 Oct to 31 Oct')
    expect(dateTestText({ from: '2026-10-01', to: '2026-10-01' }, TODAY)).toBe('on 1 Oct')
    expect([dateTestText({ from: '2027-01-01' }, TODAY), dateTestText({ to: '2026-10-31' }, TODAY)]).toEqual([
      'on or after 1 Jan 2027',
      'on or before 31 Oct',
    ])
    expect(shortDay('2026-03-09', TODAY)).toBe('9 Mar')

    const tests: DateTest[] = [
      { on: 'today' },
      { on: 'this-month' },
      { on: 'past' },
      { on: 'none' },
      { on: 'any' },
      { on: 'next', days: 30 },
      { on: 'last', days: 7 },
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-10-01' },
      { to: '2026-10-31' },
    ]
    expect(tests.map(dateTestToText)).toEqual([
      'today',
      'this-month',
      'past',
      'none',
      'any',
      'next-30',
      'last-7',
      '2026-10-01..2026-10-31',
      '2026-10-01..',
      '..2026-10-31',
    ])
    for (const t of tests) expect(dateTestFromText(dateTestToText(t))).toEqual(t)
    for (const bad of ['next', 'last', 'next-0', 'soon', '2026-13-01..', '..', '10..20']) expect(dateTestFromText(bad)).toBeUndefined()
  })

  it('a date with a time is the day it falls on where the person asking is', () => {
    const late = '2026-10-06T23:30:00Z'
    expect(dayIn(new Date(late), 'Asia/Bangkok')).toBe('2026-10-07')
    expect(dayNumberIn('Asia/Bangkok')(late)).toBe(toDay('2026-10-07'))
    expect(dayNumberIn('UTC')(late)).toBe(toDay('2026-10-06'))
    expect(dayNumberIn('America/Los_Angeles')('2026-10-06T05:00:00Z')).toBe(toDay('2026-10-05'))
    // A whole day is the same day everywhere.
    expect(dayNumberIn('Asia/Bangkok')('2026-10-06')).toBe(TODAY)
  })
})

describe('what a field has to be', () => {
  const pass = (def: BoardField, v: unknown, f: FieldFilter, ctx = {}) => fieldMatches(def, v as never, f, { today: TODAY, ...ctx })

  it('text: contains, is, and both turned round, in any case', () => {
    const v = 'Blue Harbor Cafe'
    expect([pass(company, v, { text: 'harbor' }), pass(company, v, { text: ' HARBOR ' }), pass(company, v, { text: 'pinecrest' })]).toEqual([
      true,
      true,
      false,
    ])
    expect([pass(company, v, { text: 'blue harbor cafe', match: 'is' }), pass(company, v, { text: 'blue', match: 'is' })]).toEqual([true, false])
    expect([pass(company, v, { text: 'cafe', match: 'not' }), pass(company, v, { text: 'dental', match: 'not' })]).toEqual([false, true])
    expect([pass(company, v, { text: 'blue', match: 'is-not' }), pass(company, v, { text: 'Blue Harbor Cafe', match: 'is-not' })]).toEqual([
      true,
      false,
    ])
    // The same letters written two ways are the same text.
    expect(pass(company, 'Café Olé', { text: 'café' })).toBe(true)
  })

  it('text: a card with nothing there contains nothing, and so passes "doesn’t contain" and "isn’t"', () => {
    expect([pass(company, undefined, { text: 'a' }), pass(company, undefined, { text: 'a', match: 'is' })]).toEqual([false, false])
    expect([pass(company, undefined, { text: 'a', match: 'not' }), pass(company, undefined, { text: 'a', match: 'is-not' })]).toEqual([true, true])
  })

  it('none of these: options, linked cards, people', () => {
    expect([pass(stage, ['won'], { notIn: ['won'] }), pass(stage, ['lead'], { notIn: ['won'] }), pass(stage, undefined, { notIn: ['won'] })]).toEqual(
      [false, true, true],
    )
    // "None picked" among them: a card with nothing picked is left out too.
    expect([pass(stage, undefined, { notIn: ['won', ''] }), pass(stage, ['lead'], { notIn: [''] })]).toEqual([false, true])
    // Where both are asked, "any of" is the one that counts.
    expect(pass(stage, ['won'], { in: ['won'], notIn: ['won'] })).toBe(true)
    const acme = `${HERE}:A1`
    expect([
      pass(account, [acme], { notIn: [acme] }),
      pass(account, [`${HERE}:A2`], { notIn: [acme] }),
      pass(account, undefined, { notIn: [acme] }),
    ]).toEqual([false, true, true])
    expect([pass(reviewer, ['mai'], { notIn: ['mai'] }), pass(reviewer, ['ton'], { notIn: ['mai'] })]).toEqual([false, true])
  })

  it('"me" is whoever is looking, and nobody for a visitor', () => {
    expect([pass(reviewer, ['mai'], { in: [ME] }, { me: 'mai' }), pass(reviewer, ['mai'], { in: [ME] }, { me: 'ton' })]).toEqual([true, false])
    expect(pass(reviewer, ['mai'], { in: [ME] })).toBe(false)
    expect([pass(reviewer, ['mai', 'ton'], { in: [ME, ''] }, { me: 'ton' }), pass(reviewer, undefined, { in: [ME, ''] }, { me: 'ton' })]).toEqual([
      true,
      true,
    ])
    expect([pass(reviewer, ['mai'], { notIn: [ME] }, { me: 'mai' }), pass(reviewer, ['mai'], { notIn: [ME] }, { me: 'ton' })]).toEqual([false, true])
  })

  it('a date: the tests of a day, and the three it always had', () => {
    expect([pass(close, '2026-10-06', { on: 'today' }), pass(close, '2026-10-07', { on: 'today' }), pass(close, undefined, { on: 'today' })]).toEqual(
      [true, false, false],
    )
    expect([pass(close, '2026-10-20', { on: 'this-month' }), pass(close, '2026-11-20', { on: 'this-month' })]).toEqual([true, false])
    expect([
      pass(close, '2026-10-20', { from: '2026-10-10', to: '2026-10-20' }),
      pass(close, '2026-10-21', { from: '2026-10-10', to: '2026-10-20' }),
    ]).toEqual([true, false])
    expect([
      pass(close, '2026-10-13', { date: 'week' }),
      pass(close, '2026-10-14', { date: 'week' }),
      pass(close, '2026-10-05', { date: 'past' }),
    ]).toEqual([true, false, true])
    expect([pass(close, undefined, { date: 'none' }), pass(close, '2026-10-05', { date: 'none' })]).toEqual([true, false])
    // With a time, the day depends on where the person asking is.
    const late = '2026-10-06T23:30:00Z'
    const tomorrow = toDay('2026-10-07')
    expect(pass(close, late, { on: 'today' }, { today: tomorrow, dayOf: dayNumberIn('Asia/Bangkok') })).toBe(true)
    expect(pass(close, late, { on: 'today' }, { today: tomorrow, dayOf: dayNumberIn('UTC') })).toBe(false)
  })

  it('is kept to what its field can use, and left exactly alone when it is', () => {
    const on = (id: string) => id === 'mai' || id === 'ton'
    const fine: [BoardField, FieldFilter][] = [
      [company, { text: 'a', match: 'is' }],
      [company, { text: 'a' }],
      [stage, { notIn: ['won', ''] }],
      [close, { on: 'this-month' }],
      [close, { on: 'next', days: 14 }],
      [close, { from: '2026-10-01', to: '2026-10-31' }],
      [close, { date: 'week' }],
      [reviewer, { in: [ME] }],
      [reviewer, { notIn: [ME, 'mai'] }],
    ]
    for (const [def, f] of fine) expect(tidyFilter(def, f, on)).toBe(f)

    expect(tidyFilter(company, { text: '   ' })).toBeUndefined()
    expect(tidyFilter(company, { match: 'is' })).toBeUndefined()
    expect(tidyFilter(company, { text: 'a', match: 'sounds-like' as never, min: 3 })).toEqual({ text: 'a' })
    expect(tidyFilter(company, { text: 'x'.repeat(201) })).toBeUndefined()
    expect(tidyFilter(stage, { in: ['won'], notIn: ['lead'] })).toEqual({ in: ['won'] })
    expect(tidyFilter(stage, { notIn: ['gone'] })).toBeUndefined()
    expect(tidyFilter(stage, { notIn: ['lead', 'gone'] })).toEqual({ notIn: ['lead'] })
    expect(tidyFilter(reviewer, { in: [ME, 'gone'] }, on)).toEqual({ in: [ME] })
    expect(tidyFilter(close, { on: 'next' })).toBeUndefined()
    expect(tidyFilter(close, { on: 'today', days: 5 })).toEqual({ on: 'today' })
    expect(tidyFilter(signed, { text: 'a', on: 'today', notIn: ['x'] })).toBeUndefined()
  })

  it('in words', () => {
    expect(filterText(company, { text: 'cafe' })).toBe('contains “cafe”')
    expect(filterText(company, { text: 'Acme', match: 'is' })).toBe('is “Acme”')
    expect(filterText(company, { text: 'cafe', match: 'not' })).toBe('doesn’t contain “cafe”')
    expect(filterText(company, { text: 'Acme', match: 'is-not' })).toBe('isn’t “Acme”')
    expect(filterText(stage, { notIn: ['won', ''] })).toBe('not Won, none')
    expect(filterText(reviewer, { in: [ME, ''] })).toBe('me, no one')
    expect(filterText(reviewer, { notIn: [ME, 'mai'] }, (id) => (id === 'mai' ? 'Mai' : undefined))).toBe('not me, Mai')
    expect(filterText(close, { on: 'this-month' })).toBe('this month')
    expect(filterText(value, { min: 5, max: 5 })).toBe('$5.00')
  })

  it('as text for an address, and back, for every kind', () => {
    const ref = `${HERE}:A1`
    const cases: [BoardField, FieldFilter, string][] = [
      [company, { text: 'cafe' }, '~cafe'],
      [company, { text: 'Acme', match: 'is' }, '=Acme'],
      [company, { text: 'cafe', match: 'not' }, '!~cafe'],
      [company, { text: 'Acme', match: 'is-not' }, '!=Acme'],
      // Text that begins like a test, and the words that mean "filled in" and "empty", as text to look for.
      [company, { text: '!x' }, '~!x'],
      [company, { text: '~x', match: 'is' }, '=~x'],
      [company, { text: '=x', match: 'not' }, '!~=x'],
      [company, { text: 'none', match: 'is' }, '=none'],
      [company, { text: 'any' }, '~any'],
      [company, { has: true }, 'any'],
      [company, { has: false }, 'none'],
      [stage, { in: ['won', ''] }, 'won,-'],
      [stage, { notIn: ['won'] }, '!won'],
      [stage, { notIn: ['lead', ''] }, '!lead,-'],
      [account, { in: [ref] }, encodeURIComponent(ref)],
      [account, { notIn: [ref, ''] }, `!${encodeURIComponent(ref)},-`],
      [account, { has: true }, 'any'],
      [reviewer, { in: [ME] }, 'me'],
      [reviewer, { notIn: [ME, ''] }, '!me,-'],
      [reviewer, { in: ['mai'] }, 'mai'],
      [close, { date: 'past' }, 'past'],
      [close, { date: 'week' }, 'week'],
      [close, { on: 'today' }, 'today'],
      [close, { on: 'next', days: 30 }, 'next-30'],
      [close, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-01..2026-10-31'],
      [close, { from: '2026-10-01' }, '2026-10-01..'],
      [value, { min: 10, max: 200 }, '10..200'],
      [value, { min: 10 }, '10..'],
      [signed, { checked: true }, 'yes'],
    ]
    for (const [def, f, text] of cases) {
      expect(filterToText(def, f)).toBe(text)
      expect(filterFromText(def, text)).toEqual(f)
    }
    // Text without its test in front, and a date that isn't one, can't be read.
    expect([filterFromText(company, 'cafe'), filterFromText(close, 'soon'), filterFromText(close, 'next')]).toEqual([undefined, undefined, undefined])
  })

  it('an option whose id begins with "!" is still that option, and "none of" still reads', () => {
    const odd: BoardField = {
      id: 'f-odd',
      name: 'Odd',
      type: 'choice',
      options: [
        { id: '!odd', name: 'Odd', color: 'gray' },
        { id: 'x', name: 'X', color: 'green' },
      ],
    }
    expect(filterFromText(odd, '!odd')).toEqual({ in: ['!odd'] })
    expect(filterFromText(odd, '!odd,x')).toEqual({ in: ['!odd', 'x'] })
    expect(filterToText(odd, { notIn: ['!odd'] })).toBe('!!odd')
    expect(filterFromText(odd, '!!odd')).toEqual({ notIn: ['!odd'] })
    expect(filterFromText(odd, '!x')).toEqual({ notIn: ['x'] })
  })
})

describe('the view’s filter: due, start and "me"', () => {
  const data = board({
    A1: { due: '2026-10-06', start: '2026-10-01', assigneeId: 'mai' },
    A3: { due: '2026-10-20', start: undefined, assigneeId: 'ton' },
    // (A2b isn't done: for "overdue".)
    A2b: { due: '2026-10-06' },
    B: { due: undefined, start: '2026-11-02', assigneeId: undefined },
    B1: { due: '2026-10-06T23:30:00Z', assigneeId: 'ploy' },
  })
  const idx = indexFor(data)
  const pass = (id: string, f: object, ctx = {}) => matchesFilter(idx, id, f, undefined, { today: TODAY, ...ctx })

  it('the due and start dates take any test of a day', () => {
    expect([pass('A1', { dueIs: { on: 'today' } }), pass('A3', { dueIs: { on: 'today' } }), pass('B', { dueIs: { on: 'today' } })]).toEqual([
      true,
      false,
      false,
    ])
    expect([pass('A1', { dueIs: { on: 'this-month' } }), pass('A3', { dueIs: { on: 'this-month' } })]).toEqual([true, true])
    expect([pass('B', { dueIs: { on: 'none' } }), pass('A1', { dueIs: { on: 'none' } })]).toEqual([true, false])
    expect([pass('A1', { startIs: { on: 'past' } }), pass('B', { startIs: { on: 'next-month' } }), pass('A3', { startIs: { on: 'none' } })]).toEqual([
      true,
      true,
      true,
    ])
    expect(pass('A1', { dueIs: { on: 'today' }, startIs: { on: 'future' } })).toBe(false)
    // Where "overdue" and its like are set, they are what counts.
    expect(pass('A3', { due: 'none', dueIs: { on: 'this-month' } })).toBe(false)
  })

  it('a due date with a time is the day it falls on for the person looking', () => {
    const tomorrow = toDay('2026-10-07')
    expect(pass('B1', { dueIs: { on: 'today' } }, { today: tomorrow, dayOf: dayNumberIn('Asia/Bangkok') })).toBe(true)
    expect(pass('B1', { dueIs: { on: 'today' } }, { today: TODAY, dayOf: dayNumberIn('UTC') })).toBe(true)
    expect(pass('B1', { dueIs: { on: 'today' } }, { today: TODAY, dayOf: dayNumberIn('Asia/Bangkok') })).toBe(false)
    // Overdue: a whole day once the next has begun there, a moment once it has passed.
    expect([pass('A2b', { due: 'overdue' }, { today: tomorrow }), pass('A2b', { due: 'overdue' }, { today: TODAY })]).toEqual([true, false])
    // (A finished card is never overdue.)
    expect(pass('A1', { due: 'overdue' }, { today: tomorrow })).toBe(false)
    const before = Date.parse('2026-10-06T23:00:00Z')
    const after = Date.parse('2026-10-06T23:45:00Z')
    expect([pass('B1', { due: 'overdue' }, { now: before }), pass('B1', { due: 'overdue' }, { now: after })]).toEqual([false, true])
  })

  it('"me" among the assignees is whoever is looking', () => {
    expect([pass('A1', { assignees: [ME] }, { me: 'mai' }), pass('A3', { assignees: [ME] }, { me: 'mai' }), pass('A1', { assignees: [ME] })]).toEqual(
      [true, false, false],
    )
    expect([pass('B', { assignees: [ME, ''] }, { me: 'mai' }), pass('B', { assignees: [ME] }, { me: 'mai' })]).toEqual([true, false])
    expect(pass('A3', { assignees: [ME, 'ton'] }, { me: 'mai' })).toBe(true)
  })

  it('counts as one filter each, and reads in chips', () => {
    expect([
      filterCount({ dueIs: { on: 'today' } }),
      filterCount({ due: 'week', dueIs: { on: 'today' } }),
      filterCount({ startIs: { on: 'past' } }),
    ]).toEqual([1, 1, 1])
    const chips = filterChips(
      { assignees: [ME, ''], dueIs: { on: 'today' }, startIs: { on: 'this-month' }, fields: { 'f-company': { text: 'cafe' } } },
      data.columns,
      data.labels,
      data.members,
      FIELDS,
    )
    expect(chips.map((c) => `${c.label} ${c.value}`)).toEqual(['Assignee: Me, No one', 'Due: today', 'Start: this month', 'Company: contains “cafe”'])
    // What used to read "this week" has always been the next 7 days, and now says so.
    expect(filterChips({ due: 'week' }, data.columns, data.labels, data.members)[0].value).toBe('in the next 7 days')
  })

  it('one Due choice is held one way, wherever it was picked', () => {
    expect(withDue({ on: 'today' })).toEqual({ due: undefined, dueIs: { on: 'today' } })
    expect(withDue('overdue')).toEqual({ due: 'overdue', dueIs: undefined })
    expect(withDue({ on: 'none' })).toEqual({ due: 'none', dueIs: undefined })
    expect(withDue({ on: 'next', days: 7 })).toEqual({ due: 'week', dueIs: undefined })
    expect(withDue({ on: 'next' })).toEqual({ due: undefined, dueIs: undefined })
    expect(withDue(undefined)).toEqual({ due: undefined, dueIs: undefined })
    expect([dueChoiceOf({ due: 'week' }), dueChoiceOf({ dueIs: { on: 'today' } }), dueChoiceOf({})]).toEqual(['week', { on: 'today' }, undefined])
    expect([dueText('overdue'), dueText('week'), dueText({ on: 'tomorrow' })]).toEqual(['overdue', 'in the next 7 days', 'tomorrow'])
    for (const text of ['overdue', 'week', 'none', 'today', 'this-month', 'next-30', '2026-10-01..2026-10-31'])
      expect(dueToText(dueFromText(text)!)).toBe(text)
    expect([dueFromText('next-7'), dueFromText('soon'), dueFromText('')]).toEqual(['week', undefined, undefined])
  })
})

describe('settings that hold the new tests', () => {
  const data = board({})
  const prefs = (over: Partial<ViewPrefs>): ViewPrefs => ({ ...defaultPrefs(), ...over })
  const rich = prefs({
    outline: { order: ['due', 'f:f-stage', 'status'], hidden: ['labels'] },
    filter: {
      assignees: [ME, ''],
      dueIs: { on: 'today' },
      startIs: { from: '2026-10-01', to: '2026-10-31' },
      fields: {
        'f-company': { text: 'cafe', match: 'not' },
        'f-stage': { notIn: ['won', ''] },
        'f-close': { on: 'next', days: 30 },
        'f-reviewer': { in: [ME] },
      },
    },
  })

  it('are saved and read back whole', () => {
    expect(ViewPrefsSchema.parse(rich)).toEqual(rich)
    expect(PresetSettingsSchema.parse(presetOf(rich))).toEqual(presetOf(rich))
  })

  it('are left exactly alone by cleaning, "me" included', () => {
    expect(cleanPrefs(rich, data)).toBe(rich)
  })

  it('are cleaned of what says nothing, once', () => {
    const stale = prefs({
      outline: { order: ['f:f-left', 'due', 'f:f-stage'] },
      filter: {
        assignees: [ME, 'gone'],
        due: 'overdue',
        dueIs: { on: 'today' },
        startIs: { on: 'next' },
        fields: { 'f-company': { text: ' ' }, 'f-stage': { in: ['won'], notIn: ['lead'] }, 'f-reviewer': { in: [ME, 'gone'] } },
      },
    })
    const cleaned = cleanPrefs(stale, data)
    expect(cleaned.filter.assignees).toEqual([ME])
    expect([cleaned.filter.due, cleaned.filter.dueIs, cleaned.filter.startIs]).toEqual(['overdue', undefined, undefined])
    expect(cleaned.filter.fields).toEqual({ 'f-stage': { in: ['won'] }, 'f-reviewer': { in: [ME] } })
    expect(cleaned.outline.order).toEqual(['due', 'f:f-stage'])
    expect(cleanPrefs(cleaned, data)).toBe(cleaned)
  })

  it('a value this version doesn’t know is left out, and nothing else is lost with it', () => {
    const settings = {
      ...presetOf(rich),
      filter: {
        due: 'week',
        dueIs: { on: 'the-day-after' },
        startIs: 'whenever',
        fields: { 'f-close': { date: 'week', on: 'the-day-after', days: 'many' }, 'f-company': { text: 'cafe', match: 'rhymes-with' } },
      },
      outline: { hidden: ['labels'], order: 'by-colour' },
    }
    const read = PresetSettingsSchema.parse(settings)
    // (A test left with nothing to ask is an empty one: it hides no card, and cleaning takes it away.)
    expect(read.filter).toEqual({ due: 'week', dueIs: {}, fields: { 'f-close': { date: 'week' }, 'f-company': { text: 'cafe' } } })
    expect([dateMatches(undefined, read.filter.dueIs!, TODAY), tidyDateTest(read.filter.dueIs!)]).toEqual([true, undefined])
    expect(read.outline).toEqual({ hidden: ['labels'] })
    // What the first filters could say is still refused when it's wrong, as it always was.
    expect(PresetSettingsSchema.safeParse({ ...presetOf(rich), filter: { due: 'soon' } }).success).toBe(false)
  })

  it('read by the version before these tests existed, they lose only the new parts', () => {
    // (That version's schema, as it was: what a tab left open across the update, or a roll-back, would read with.)
    const before = z.object({
      due: z.enum(['overdue', 'week', 'none']).optional(),
      assignees: z.array(z.string()).optional(),
      fields: z
        .record(
          z.string(),
          z.object({
            in: z.array(z.string()).optional(),
            checked: z.boolean().optional(),
            min: z.number().optional(),
            max: z.number().optional(),
            date: z.enum(['past', 'week', 'none']).optional(),
            has: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    const read = before.parse({
      ...rich.filter,
      due: 'week',
      fields: { ...rich.filter.fields, 'f-value': { min: 10 }, 'f-close': { date: 'past', on: 'today' } },
    })
    expect(read.due).toBe('week')
    expect(read.fields).toEqual({ 'f-company': {}, 'f-stage': {}, 'f-close': { date: 'past' }, 'f-reviewer': { in: [ME] }, 'f-value': { min: 10 } })
  })

  it('follow their fields when two are merged or a board is made from a starter', () => {
    const map: FieldMap = new Map([['f-stage', { id: 'f-new', options: new Map([['won', 'closed']]) }]])
    const s = presetOf(
      prefs({
        outline: { order: ['due', 'f:f-stage', 'f:f-company', 'f:f-new'], hidden: ['f:f-stage'] },
        filter: { dueIs: { on: 'today' }, assignees: [ME], fields: { 'f-stage': { notIn: ['won', 'lead', ''] }, 'f-company': { text: 'cafe' } } },
      }),
    )
    const kept = remapPreset(s, map, 'keep')
    expect(kept.filter).toEqual({
      dueIs: { on: 'today' },
      assignees: [ME],
      fields: { 'f-company': { text: 'cafe' }, 'f-new': { notIn: ['closed', ''] } },
    })
    // Two columns that land on one field keep the first one's place.
    expect(kept.outline).toEqual({ order: ['due', 'f:f-new', 'f:f-company'], hidden: ['f:f-new'] })
    const dropped = remapPreset(s, map, 'drop')
    expect(dropped.filter.fields).toEqual({ 'f-new': { notIn: ['closed', ''] } })
    expect(dropped.outline).toEqual({ order: ['due', 'f:f-new'], hidden: ['f:f-new'] })
  })

  it('a saved filter with no arrangement of its own still counts as unchanged', () => {
    expect(matchesPreset(prefs({ outline: { order: undefined } }), presetOf(defaultPrefs()))).toBe(true)
  })
})

describe('the Outline’s columns, arranged', () => {
  const all = ['status', 'progress', 'due', 'f:a', 'f:b']

  it('go in the order someone gave them, with new ones after and gone ones skipped', () => {
    expect(arrangeColumns(all)).toBe(all)
    expect(arrangeColumns(all, [])).toBe(all)
    expect(arrangeColumns(all, ['f:b', 'due'])).toEqual(['f:b', 'due', 'status', 'progress', 'f:a'])
    expect(arrangeColumns(all, ['f:gone', 'due', 'due', 'f:a'])).toEqual(['due', 'f:a', 'status', 'progress', 'f:b'])
  })

  it('moving one gives the whole arrangement, and nothing when it is back where it came from', () => {
    const moved = moveColumn(all, undefined, 'f:b', 'status')
    expect(moved).toEqual(['f:b', 'status', 'progress', 'due', 'f:a'])
    expect(moveColumn(all, moved, 'f:b', null)).toBeUndefined()
    expect(moveColumn(all, undefined, 'status', null)).toEqual(['progress', 'due', 'f:a', 'f:b', 'status'])
    expect(moveColumn(all, undefined, 'due', 'due')).toBeUndefined()
    expect(moveColumn(all, ['due', 'status'], 'f:a', 'status')).toEqual(['due', 'f:a', 'status', 'progress', 'f:b'])
  })
})

describe('Search cards: the due date', () => {
  const card = (over: Partial<CardFacts> = {}): CardFacts => ({
    text: 'colour with ben',
    labels: [],
    kind: 'todo',
    done: false,
    archived: false,
    leaf: true,
    createdAt: 0,
    activeAt: 0,
    doneAt: null,
    archivedAt: null,
    ...over,
  })

  it('takes any test of a day, by the day the person asking is in', () => {
    const late = '2026-10-06T23:30:00Z'
    const tomorrow = toDay('2026-10-07')
    const inBangkok = card({ due: late, dueDay: dayNumberIn('Asia/Bangkok')(late) })
    expect(matchesCard(inBangkok, { dueIs: { on: 'today' }, today: tomorrow })).toBe(true)
    expect(matchesCard(inBangkok, { dueIs: { on: 'today' }, today: TODAY })).toBe(false)
    expect(matchesCard(card(), { dueIs: { on: 'today' }, today: TODAY })).toBe(false)
    expect(matchesCard(card(), { dueIs: { on: 'none' }, today: TODAY })).toBe(true)
    expect(matchesCard(card({ due: '2026-10-20', dueDay: toDay('2026-10-20') }), { dueIs: { on: 'this-month' }, today: TODAY })).toBe(true)
  })

  it('overdue: a whole day once the next has begun for them', () => {
    const yesterday = card({ due: '2026-10-05', dueDay: toDay('2026-10-05') })
    expect(matchesCard(yesterday, { due: 'overdue', today: TODAY })).toBe(true)
    expect(matchesCard(yesterday, { due: 'overdue', today: toDay('2026-10-05') })).toBe(false)
    expect(matchesCard(card({ ...yesterday, done: true }), { due: 'overdue', today: TODAY })).toBe(false)
  })
})

describe('the search box', () => {
  const task = (title: string, custom?: Task['custom']) => ({ title, custom })

  it('looks in the title and in text fields, and nowhere else', () => {
    const m = matcher(' Northwind ', FIELDS)!
    expect(m(task('Northwind Traders: new website'))).toBe(true)
    expect(m(task('New website', { 'f-company': 'northwind traders' }))).toBe(true)
    expect(m(task('New website', { 'f-company': 'Blue Harbor' }))).toBe(false)
    // A number that happens to read the same isn't text.
    expect(matcher('12', FIELDS)!(task('Deal', { 'f-value': 12 }))).toBe(false)
    // Without the board's fields, the title alone.
    expect(matcher('northwind')!(task('New website', { 'f-company': 'northwind traders' }))).toBe(false)
    expect(matcher('  ')).toBeNull()
  })
})
