import { describe, expect, it } from 'vitest'
import { describeChanges } from './activity'
import { execute } from './commands'
import { todayDay } from './dates'
import {
  carryCustom,
  checkValue,
  fieldKey,
  fieldMatches,
  filterFromText,
  filterText,
  filterToText,
  linkRef,
  mapLinks,
  matchFields,
  parseRef,
  planAdoption,
  saidFilter,
  tidyFilter,
  valuePlain,
  valueText,
  type BoardField,
  type CustomValues,
} from './fields'
import { newId } from './ids'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import { cleanPrefs, defaultPrefs, type ViewPrefs } from './prefs'
import { exampleData } from './sample'
import { CommandSchema, ViewPrefsSchema } from './schema'
import { filterChips, matchesFilter, sortComparator } from './table'
import { readBoardFile } from './transfer'
import type { BoardData, Task } from './types'

const HERE = '01900000-0000-7000-8000-00000000000a'
const THERE = '01900000-0000-7000-8000-00000000000b'
const company: BoardField = { id: 'f-company', name: 'Company', type: 'link', linkTo: 'board', board: THERE }
const related: BoardField = { id: 'f-related', name: 'Related', type: 'link', linkTo: 'same', many: true }
const anything: BoardField = { id: 'f-any', name: 'Anything', type: 'link', many: true }
const acme = linkRef(THERE, 'c1')
const globex = linkRef(THERE, 'c2')
const here = (id: string) => linkRef(HERE, id)

/** The example board (A2 has subtasks A2a and A2b) under a real board id, with the three link fields. */
function board(values: Record<string, CustomValues> = {}, id = HERE): BoardData {
  const data = exampleData(id)
  return {
    ...data,
    fields: [company, related, anything],
    tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, values[t.id] ? { ...t, custom: values[t.id] } : t])),
  }
}
const run = (data: BoardData, id: string, custom: Record<string, unknown>) =>
  execute(data, { type: 'task.update', id, fields: { custom: custom as never } }, { now: new Date().toISOString(), newId, idx: indexFor(data) })

describe('a link', () => {
  it('names a board and a card, and nothing else reads as one', () => {
    expect(parseRef(acme)).toEqual({ boardId: THERE, taskId: 'c1' })
    // (A card's id may hold a colon: the board's can't.)
    expect(parseRef(linkRef(THERE, 'a:b'))).toEqual({ boardId: THERE, taskId: 'a:b' })
    for (const bad of ['c1', ':c1', `${THERE}:`, 'board:c1', `${THERE}c1`, `${THERE}:${'x'.repeat(300)}`]) expect(parseRef(bad)).toBeNull()
  })

  it('as long as two ids and a colon, it passes every check on the way in and into saved view settings', () => {
    const long = linkRef(THERE, 'x'.repeat(100))
    expect(long.length).toBe(137)
    expect(CommandSchema.safeParse({ type: 'task.update', id: 'A1', fields: { custom: { 'f-any': [long] } } }).success).toBe(true)
    const prefs = { ...defaultPrefs(), filter: { fields: { 'f-any': { in: [long, ''] } } } }
    expect(ViewPrefsSchema.safeParse(prefs).success).toBe(true)
  })
})

describe('setting a link', () => {
  it('is checked with what the board knows: the field’s board, how many, itself, and cards of this board', () => {
    const data = board()
    const error = (id: string, custom: Record<string, unknown>) => (run(data, id, custom) as { error?: string }).error
    expect(error('A1', { 'f-company': [acme] })).toBeUndefined()
    expect(error('A1', { 'f-company': acme })).toBeUndefined()
    expect(error('A1', { 'f-company': [acme, globex] })).toMatch(/holds one card/)
    expect(error('A1', { 'f-company': [here('A3')] })).toMatch(/isn’t on the board this field links to/)
    expect(error('A1', { 'f-company': ['c1'] })).toMatch(/isn’t a card/)
    expect(error('A1', { 'f-related': [here('A3'), here('A4')] })).toBeUndefined()
    expect(error('A1', { 'f-related': [acme] })).toMatch(/same board/)
    expect(error('A1', { 'f-related': [here('A1')] })).toMatch(/itself/)
    expect(error('A1', { 'f-related': [here('nope')] })).toMatch(/isn’t on this board any more/)
    expect(error('A1', { 'f-any': Array.from({ length: 21 }, (_, i) => linkRef(THERE, `c${i}`)) })).toMatch(/too many/)
    // A card on another board is the server's to check: here it only has to be a link.
    expect(error('A1', { 'f-any': [acme, here('A3')] })).toBeUndefined()
  })

  it('never refuses what the card already held, and reading leniently keeps every link', () => {
    // The card holds two companies (the field took several once) and a link that's off the field's board.
    const data = board({ A1: { 'f-company': [acme, here('A3')], 'f-related': [acme] } })
    const after = (custom: Record<string, unknown>) => {
      const r = run(data, 'A1', custom)
      return 'changes' in r ? (r.changes[0].after as Task).custom : r.error
    }
    // Taking one away, or keeping them as they are beside another change, is fine; adding to them isn't.
    expect(after({ 'f-company': [here('A3')] })).toMatchObject({ 'f-company': [here('A3')] })
    expect(after({ 'f-company': [acme, here('A3'), globex] })).toMatch(/holds one card/)
    expect(after({ 'f-related': [acme, here('A4')] })).toMatchObject({ 'f-related': [acme, here('A4')] })
    expect(checkValue(company, [acme, globex, 'junk'], true)).toEqual({ value: [acme, globex] })
    expect(checkValue(company, [], true)).toEqual({ value: undefined })
  })

  it('never comes out as text: titles when they’re all known, a count otherwise', () => {
    const titleOf = (ref: string) => ({ [acme]: 'Acme', [globex]: 'Globex' })[ref]
    expect(valueText(anything, [acme, globex], titleOf)).toBe('Acme, Globex')
    expect(valueText(anything, [acme, here('A1')], titleOf)).toBe('2 cards')
    expect(valueText(anything, [acme])).toBe('a card')
    expect(valuePlain(anything, [acme, globex])).toBe('2 cards')
    // The activity log names cards of this board, and never one of another.
    const data = board()
    const log = (custom: Record<string, unknown>) => {
      const r = run(data, 'A1', custom)
      return 'changes' in r ? describeChanges(data, r.changes).map((i) => i.text) : []
    }
    expect(log({ 'f-related': [here('A3'), here('A4')] })).toEqual(['set Related of “Buy domain” to “Deploy”, “Write the launch blog post”'])
    expect(log({ 'f-company': [acme] })).toEqual(['set Company of “Buy domain” to a card on another board'])
    expect(log({ 'f-any': [acme, here('A3')] })).toEqual(['set Anything of “Buy domain” to 2 cards'])
  })
})

describe('filtering and sorting by a link', () => {
  const data = board({ A1: { 'f-company': [acme] }, A3: { 'f-company': [globex] } })
  const idx = indexFor(data)
  const today = todayDay()

  it('by the cards linked, by none, and by whether there is one', () => {
    const pass = (id: string, f: object) => fieldMatches(company, data.tasks[id].custom?.['f-company'], f, { today })
    expect([pass('A1', { in: [acme] }), pass('A3', { in: [acme] }), pass('A4', { in: [acme] })]).toEqual([true, false, false])
    // "None linked" doesn't match a card that has a link.
    expect([pass('A1', { in: [''] }), pass('A4', { in: [''] }), pass('A4', { in: ['', acme] })]).toEqual([false, true, true])
    expect([pass('A1', { has: true }), pass('A4', { has: true }), pass('A4', { has: false })]).toEqual([true, false, true])
    expect(matchesFilter(idx, 'A3', { fields: { 'f-company': { in: [globex] } } })).toBe(true)
  })

  it('a filter keeps its links (no list to check them against), reads with titles, and travels in an address', () => {
    const f = { in: [acme, '', 'junk'], min: 3 }
    expect(tidyFilter(company, f)).toEqual({ in: [acme, ''] })
    const kept = { in: [acme, ''] }
    expect(tidyFilter(company, kept)).toBe(kept)
    expect(filterText(company, kept, () => 'Acme')).toBe('Acme, none')
    expect(filterText(company, kept)).toBe('a card, none')
    expect(filterChips({ fields: { 'f-company': kept } }, data.columns, data.labels, data.members, data.fields, () => 'Acme').at(-1)).toMatchObject({
      label: 'Company:',
      value: 'Acme, none',
    })
    const odd = { in: [linkRef(THERE, 'a,b'), ''] }
    expect(filterFromText(company, filterToText(company, odd))).toEqual(odd)
    expect(filterFromText(company, 'any')).toEqual({ has: true })
    expect(filterToText(company, { has: false })).toBe('none')
    // Saved view settings with a link filter settle: cleaning them twice gives the same object back.
    const prefs: ViewPrefs = { ...defaultPrefs(), filter: { fields: { 'f-company': kept } } }
    const once = cleanPrefs(prefs, data)
    expect(cleanPrefs(once, data)).toBe(once)
    expect(once.filter.fields).toEqual({ 'f-company': kept })
  })

  it('sorts by the first linked card’s title, with unknown ones last either way', () => {
    const titleOf = (ref: string) => ({ [acme]: 'Acme', [globex]: 'Globex' })[ref]
    const sorted = (dir: 'asc' | 'desc', t: (ref: string) => string | undefined = titleOf) =>
      ['A4', 'A3', 'A1'].sort(sortComparator(idx, { key: fieldKey('f-company'), dir }, new Map(), t))
    expect(sorted('asc')).toEqual(['A1', 'A3', 'A4'])
    expect(sorted('desc')).toEqual(['A3', 'A1', 'A4'])
    expect(sorted('asc', (ref) => (ref === globex ? 'Globex' : undefined))).toEqual(['A3', 'A4', 'A1'])
  })

  it('an assistant finds by the link as it’s stored, or by nothing', () => {
    const find = (said: string | null) => saidFilter(company, said)
    expect('test' in find(acme) && (find(acme) as { test: (v: unknown) => boolean }).test([acme])).toBe(true)
    expect((find(null) as { test: (v: unknown) => boolean }).test(undefined)).toBe(true)
    expect(find('Acme')).toHaveProperty('error')
  })
})

describe('carrying links', () => {
  it('a card moving to another board keeps them on the very same field, renumbering the ones to cards that move along', () => {
    const source = board({ A2: { 'f-related': [here('A2a'), here('A3')], 'f-company': [acme] } })
    const target = { ...board({}, THERE), fields: [related, { ...company, id: 'f-other' }] }
    const plan = planMove(source, target, 'A2', {}, { now: new Date().toISOString(), newId })
    if ('error' in plan) throw new Error(plan.error)
    const moved = plan.target.map((c) => c.after as Task).find((t) => t.title === 'Design')!
    // The subtask's link follows it to its new id; the one to a card left behind still names the old board.
    expect(moved.custom).toEqual({ 'f-related': [linkRef(THERE, plan.ids.get('A2a')!), here('A3')] })
    // "Company" there is another field that's only named alike: links never go to it.
    expect(plan.summary.droppedFields).toEqual(['Company'])
    expect(matchFields([company], [{ ...company, id: 'f-other' }]).unmatched).toEqual([company])
    expect(matchFields([company], [company]).map.get('f-company')).toEqual({ id: 'f-company', link: true })
  })

  it('changing links leaves everything else, and gives the same values back when nothing changed', () => {
    const custom: CustomValues = { 'f-any': [acme, globex], 'f-text': 'kept', 'f-choice': ['won'] }
    const links = new Set(['f-any'])
    expect(mapLinks(custom, links, (r) => r)).toBe(custom)
    expect(mapLinks(custom, links, (r) => (r === acme ? null : r))).toEqual({ ...custom, 'f-any': [globex] })
    expect(mapLinks(custom, links, () => null)).toEqual({ 'f-text': 'kept', 'f-choice': ['won'] })
    expect(mapLinks({ 'f-any': [acme] }, links, () => null)).toBeUndefined()
    expect(
      carryCustom({ 'f-any': [acme, globex] }, new Map([['f-any', { id: 'f-new', link: true }]]), {
        relink: (r) => (r === acme ? here('A1') : null),
      }),
    ).toEqual({
      'f-new': [here('A1')],
    })
  })

  it('a field arriving in another library keeps its board only when that board came with it', () => {
    const adopt = (self?: { was: string; is: string }) =>
      planAdoption([], [company, related], { canAdd: true, room: 10, newId: () => `new-${Math.random()}`, ...(self && { self }) }).add
    expect(adopt().map((f) => [f.name, f.linkTo, f.board])).toEqual([
      ['Company', 'board', undefined],
      ['Related', 'same', undefined],
    ])
    expect(adopt({ was: THERE, is: HERE })[0]).toMatchObject({ linkTo: 'board', board: HERE })
    // One the library has by name is used as it is, whatever it points at.
    const own: BoardField = { ...company, id: 'f-own', board: HERE }
    const plan = planAdoption([own], [company], { canAdd: false, room: 0, newId })
    expect(plan.map.get('f-company')).toEqual({ id: 'f-own', link: true })
  })

  it('a board read from a file keeps the links between its own cards, under its new id', () => {
    const self: BoardField = { ...company, board: HERE }
    const data = {
      ...board({ A1: { 'f-company': [here('A3'), acme], 'f-any': [acme] }, A3: { 'f-related': [here('A1')] } }),
      fields: [self, related, anything],
    }
    const read = readBoardFile({ app: 'kanbanto', format: 3, data }, THERE)
    expect(read.board.id).toBe(THERE)
    expect(read.tasks.A1.custom).toEqual({ 'f-company': [linkRef(THERE, 'A3')] })
    expect(read.tasks.A3.custom).toEqual({ 'f-related': [linkRef(THERE, 'A1')] })
    expect(read.fields[0]).toMatchObject({ board: THERE })
    expect(JSON.stringify(read)).not.toContain(HERE)
  })
})
