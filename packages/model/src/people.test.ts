import { describe, expect, it } from 'vitest'
import { describeChanges } from './activity'
import { applyChanges, invertChanges } from './changes'
import { execute, type Command } from './commands'
import { todayDay } from './dates'
import {
  carryCustom,
  checkValue,
  fieldKey,
  fieldMatches,
  filterFromText,
  filterText,
  filterToText,
  matchFields,
  parseValue,
  peopleLeftBehind,
  saidFilter,
  tidyCustom,
  tidyFilter,
  valuePlain,
  valueText,
  compareValues,
  type BoardField,
  type CustomValues,
} from './fields'
import { newId } from './ids'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import { cleanPrefs, defaultPrefs, type ViewPrefs } from './prefs'
import { exampleData } from './sample'
import { BoardFieldSchema, CommandSchema } from './schema'
import { filterChips, matchesFilter, sortComparator } from './table'
import { readBoardFile } from './transfer'
import type { BoardData, Task } from './types'

const NOW = '2026-10-05T09:00:00.000Z'
const HERE = '01900000-0000-7000-8000-00000000000a'
const THERE = '01900000-0000-7000-8000-00000000000b'
const reviewer: BoardField = { id: 'f-reviewer', name: 'Reviewer', type: 'person' }
const team: BoardField = { id: 'f-team', name: 'Team', type: 'person', many: true }
/** Someone who isn't on the board (any more). */
const GONE = 'zed'

/** The example board (people: mai, ton, ploy) with the two person fields. */
function board(values: Record<string, CustomValues> = {}, id = HERE): BoardData {
  const data = exampleData(id)
  return {
    ...data,
    fields: [reviewer, team],
    tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, values[t.id] ? { ...t, custom: values[t.id] } : t])),
  }
}
const ctx = (data: BoardData) => ({ now: NOW, newId, idx: indexFor(data) })
function exec(data: BoardData, cmd: Command) {
  const r = execute(data, cmd, ctx(data))
  if ('error' in r) throw new Error(r.error)
  return { data: applyChanges(data, r.changes), changes: r.changes }
}
const refusal = (data: BoardData, cmd: Command) => {
  const r = execute(data, cmd, ctx(data))
  return 'error' in r ? r.error : null
}
const set = (data: BoardData, id: string, custom: Record<string, unknown>) =>
  exec(data, { type: 'task.update', id, fields: { custom: custom as never } })
const on = (id: string) => ['mai', 'ton', 'ploy'].includes(id)
const names = (id: string) => ({ mai: 'Mai', ton: 'Ton', ploy: 'Ploy' })[id]

describe('a person value', () => {
  it('is one of the board’s people, or several where the field says so', () => {
    expect(checkValue(reviewer, 'mai', false, { isMember: on })).toEqual({ value: ['mai'] })
    expect(checkValue(reviewer, ['mai'], false, { isMember: on })).toEqual({ value: ['mai'] })
    expect(checkValue(reviewer, [], false, { isMember: on })).toEqual({ value: undefined })
    expect(checkValue(reviewer, ['mai', 'ton'], false, { isMember: on })).toEqual({ error: 'This field holds one person.' })
    expect(checkValue(team, ['mai', 'ton', 'mai'], false, { isMember: on })).toEqual({ value: ['mai', 'ton'] })
    expect(checkValue(reviewer, GONE, false, { isMember: on })).toEqual({ error: 'That person isn’t on this board.' })
    expect(checkValue(reviewer, 7, false, { isMember: on })).toHaveProperty('error')
    expect(checkValue(team, ['mai', ''], false, { isMember: on })).toEqual({ error: 'That isn’t a person.' })
    expect(checkValue(team, ['a:b'], false, { isMember: on })).toEqual({ error: 'That isn’t a person.' })
    const crowd = Array.from({ length: 21 }, (_, i) => `p${i}`)
    expect(checkValue(team, crowd, false, { isMember: () => true })).toHaveProperty('error')
  })

  it('someone the card held who has left is dropped quietly, so the others can still be changed', () => {
    const held = { held: ['mai', GONE], isMember: on }
    expect(checkValue(team, ['mai', GONE, 'ton'], false, held)).toEqual({ value: ['mai', 'ton'] })
    expect(checkValue(team, [GONE], false, { held: [GONE], isMember: on })).toEqual({ value: undefined })
    // Someone new who isn't on the board is still refused, whoever else is in the list.
    expect(checkValue(team, ['mai', GONE, 'other'], false, held)).toEqual({ error: 'That person isn’t on this board.' })
    // A field for one person that held someone who left can be given someone else.
    expect(checkValue(reviewer, [GONE, 'ton'], false, { held: [GONE], isMember: on })).toEqual({ value: ['ton'] })
  })

  it('read leniently keeps only people on the board, when that’s known', () => {
    expect(checkValue(team, ['mai', GONE], true, { isMember: on })).toEqual({ value: ['mai'] })
    expect(checkValue(team, ['mai', GONE], true)).toEqual({ value: ['mai', GONE] })
    expect(tidyCustom({ 'f-team': ['mai', GONE], 'f-reviewer': [GONE] }, [reviewer, team], on)).toEqual({ 'f-team': ['mai'] })
    expect(tidyCustom({ 'f-team': ['mai', GONE] }, [team])).toEqual({ 'f-team': ['mai', GONE] })
    expect(parseValue(reviewer, 'mai')).toEqual({ value: ['mai'] })
    expect(parseValue(reviewer, null)).toEqual({ value: undefined })
  })

  it('goes through the schemas: a list of ids on a card, and one or several on the field', () => {
    expect(CommandSchema.safeParse({ type: 'task.update', id: 'A3', fields: { custom: { 'f-team': ['mai', 'ton'] } } }).success).toBe(true)
    expect(BoardFieldSchema.safeParse(team).success).toBe(true)
    expect(BoardFieldSchema.parse(team)).toMatchObject({ type: 'person', many: true })
  })
})

describe('setting people on a card', () => {
  it('only people on the board, checked where the command runs', () => {
    const { data } = set(board(), 'A3', { 'f-reviewer': ['ton'], 'f-team': ['mai', 'ploy'] })
    expect(data.tasks.A3.custom).toEqual({ 'f-reviewer': ['ton'], 'f-team': ['mai', 'ploy'] })
    expect(refusal(board(), { type: 'task.update', id: 'A3', fields: { custom: { 'f-reviewer': [GONE] } } })).toBe(
      'Reviewer: That person isn’t on this board.',
    )
    expect(
      refusal(board(), { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'New', custom: { 'f-team': ['mai', GONE] } } }),
    ).toMatch(/isn’t on this board/)
    expect(set(data, 'A3', { 'f-reviewer': null }).data.tasks.A3.custom).toEqual({ 'f-team': ['mai', 'ploy'] })
  })

  it('an undo can’t put someone on a card who isn’t on the board', () => {
    const start = board({ A3: { 'f-team': ['mai'] } })
    const { data: renamed, changes } = exec(start, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    const undo = invertChanges(renamed, changes, NOW)
    // A crafted undo: the record it restores names a stranger.
    const forged = undo.map((c) =>
      c.after && c.entity === 'task' ? { ...c, after: { ...c.after, custom: { 'f-team': ['mai', GONE], 'f-reviewer': [GONE] } } } : c,
    )
    const { data: undone } = exec(renamed, { type: 'records.restore', changes: forged as never })
    expect(undone.tasks.A3.custom).toEqual({ 'f-team': ['mai'] })
    // The same for someone who left in between, and for a card coming out of the archive.
    const left: BoardData = { ...renamed, members: renamed.members.filter((m) => m.id !== 'mai') }
    expect(exec(left, { type: 'records.restore', changes: undo }).data.tasks.A3.custom).toBeUndefined()
    const { data: put } = exec(start, { type: 'task.archive', id: 'A3' })
    const { data: back } = exec({ ...put, members: put.members.filter((m) => m.id !== 'mai') }, { type: 'task.restore', id: 'A3' })
    expect(back.tasks.A3.custom).toBeUndefined()
  })
})

describe('people in words', () => {
  it('reads as names and never as ids', () => {
    expect(valueText(team, ['mai', 'ton'], names)).toBe('Mai, Ton')
    expect(valueText(team, ['mai', GONE], names)).toBe('Mai, someone who left')
    expect(valueText(team, ['mai', 'ton'])).toBe('someone who left, someone who left')
    expect(valuePlain(team, ['mai', GONE], names)).toBe('Mai, someone who left')
    expect(valuePlain(team, ['mai', GONE])).not.toMatch(/mai|zed/)
    // A kind this code doesn't know never has its value printed.
    const odd = { id: 'f-odd', name: 'Odd', type: 'later' as never }
    expect(valueText(odd, ['secret-id'])).toBe('')
    expect(valuePlain(odd, ['secret-id'])).toBe('')
  })

  it('the activity log names them', () => {
    const start = board()
    const { changes } = set(start, 'A3', { 'f-team': ['ton', 'ploy'] })
    expect(describeChanges(start, changes).map((i) => i.text)).toEqual(['set Team of “Deploy” to Ton, Ploy'])
    const held = board({ A3: { 'f-team': ['ton'] } })
    expect(describeChanges(held, set(held, 'A3', { 'f-team': null }).changes).map((i) => i.text)).toEqual(['cleared Team of “Deploy”'])
  })
})

describe('filtering and sorting by a person', () => {
  const data = board({ A1: { 'f-reviewer': ['ton'] }, A3: { 'f-reviewer': ['mai'] }, A4: { 'f-reviewer': [GONE] } })
  const idx = indexFor(data)
  const today = todayDay()

  it('by who it is, by no one, and by whether there is someone', () => {
    const pass = (id: string, f: object) => fieldMatches(reviewer, data.tasks[id].custom?.['f-reviewer'], f, today, on)
    expect([pass('A1', { in: ['ton'] }), pass('A3', { in: ['ton'] }), pass('B', { in: ['ton'] })]).toEqual([true, false, false])
    expect([pass('A1', { in: [''] }), pass('B', { in: [''] }), pass('B', { in: ['', 'ton'] })]).toEqual([false, true, true])
    // A card that only holds someone who left has no one.
    expect([pass('A4', { in: [''] }), pass('A4', { has: false }), pass('A4', { has: true })]).toEqual([true, true, false])
    expect([pass('A1', { has: true }), pass('B', { has: true })]).toEqual([true, false])
    expect(matchesFilter(idx, 'A3', { fields: { 'f-reviewer': { in: ['mai'] } } })).toBe(true)
    expect(matchesFilter(idx, 'A4', { fields: { 'f-reviewer': { in: [''] } } })).toBe(true)
  })

  it('a filter keeps people who are on the board, reads with names, and travels in an address', () => {
    expect(tidyFilter(reviewer, { in: ['ton', '', 'a:b'], min: 3 })).toEqual({ in: ['ton', ''] })
    expect(tidyFilter(reviewer, { in: ['ton', GONE, ''] }, on)).toEqual({ in: ['ton', ''] })
    const kept = { in: ['ton', ''] }
    expect(tidyFilter(reviewer, kept, on)).toBe(kept)
    expect(filterText(reviewer, kept, names)).toBe('Ton, no one')
    expect(filterText(reviewer, { in: [GONE] }, names)).toBe('someone who left')
    expect(filterChips({ fields: { 'f-reviewer': kept } }, data.columns, data.labels, data.members, data.fields).at(-1)).toMatchObject({
      label: 'Reviewer:',
      value: 'Ton, no one',
    })
    expect(filterFromText(reviewer, filterToText(reviewer, kept))).toEqual(kept)
    expect(filterFromText(reviewer, 'me')).toEqual({ in: ['me'] })
    expect(filterFromText(reviewer, 'any')).toEqual({ has: true })
    expect(filterToText(reviewer, { has: false })).toBe('none')
    // Saved view settings drop someone who left, and then settle.
    const prefs: ViewPrefs = { ...defaultPrefs(), filter: { fields: { 'f-reviewer': { in: ['ton', GONE] } } } }
    const once = cleanPrefs(prefs, data)
    expect(once.filter.fields).toEqual({ 'f-reviewer': { in: ['ton'] } })
    expect(cleanPrefs(once, data)).toBe(once)
  })

  it('sorts by the first person’s name, with no one (or only someone who left) last either way', () => {
    const sorted = (dir: 'asc' | 'desc') => ['B', 'A4', 'A1', 'A3'].sort(sortComparator(idx, { key: fieldKey('f-reviewer'), dir }, new Map()))
    expect(sorted('asc')).toEqual(['A3', 'A1', 'B', 'A4'])
    expect(sorted('desc')).toEqual(['A1', 'A3', 'B', 'A4'])
    expect(compareValues(reviewer, ['ton'], ['mai'], names)).toBeGreaterThan(0)
    expect(compareValues(reviewer, [GONE], ['mai'], names)).toBeGreaterThan(0)
  })

  it('an assistant finds by the person’s id, or by nobody', () => {
    const find = (said: string | null) => saidFilter(reviewer, said) as { test: (v: unknown) => boolean }
    expect(find('ton').test(['ton'])).toBe(true)
    expect(find('ton').test(['mai'])).toBe(false)
    expect(find(null).test(undefined)).toBe(true)
  })
})

describe('carrying people', () => {
  it('a card moving to another board keeps the people who are on that board, and says who stays behind', () => {
    const source = board({ A2: { 'f-reviewer': ['ton'], 'f-team': ['mai', 'ton'] }, A2a: { 'f-reviewer': ['ploy'] } })
    const there = board({}, THERE)
    // The other board has a field named alike (another library's), and only Mai and Ploy.
    const target: BoardData = {
      ...there,
      members: there.members.filter((m) => m.id !== 'ton'),
      fields: [{ ...reviewer, id: 'f-other' }, team],
    }
    const plan = planMove(source, target, 'A2', {}, { now: NOW, newId })
    if ('error' in plan) throw new Error(plan.error)
    const moved = (title: string) => plan.target.map((c) => c.after as Task).find((t) => t.title === title)!
    expect(moved('Design').custom).toEqual({ 'f-team': ['mai'] })
    expect(moved('Homepage').custom).toEqual({ 'f-other': ['ploy'] })
    expect(plan.summary.leftBehind).toEqual(['Ton'])
    // A field that lost its people isn't a field that "can't come along".
    expect(plan.summary.droppedFields).toEqual([])
    expect(matchFields([reviewer], [{ ...reviewer, id: 'f-other' }]).map.get('f-reviewer')).toEqual({ id: 'f-other', people: true })
  })

  it('carried by a map, people go as they are unless someone says who is there', () => {
    const map = new Map([['f-team', { id: 'f-new', people: true }]])
    expect(carryCustom({ 'f-team': ['mai', GONE] }, map)).toEqual({ 'f-new': ['mai', GONE] })
    expect(carryCustom({ 'f-team': ['mai', GONE] }, map, { isMember: on })).toEqual({ 'f-new': ['mai'] })
    expect(carryCustom({ 'f-team': [GONE] }, map, { isMember: on })).toBeUndefined()
    expect(peopleLeftBehind({ 'f-team': ['mai', GONE], 'f-x': ['q'] }, map, on)).toBe(1)
  })

  it('a board file keeps the people it lists, and nobody else', () => {
    const data = board({ A3: { 'f-team': ['mai', GONE] } })
    const read = readBoardFile({ app: 'kanbanto', format: 3, data }, THERE)
    expect(read.tasks.A3.custom).toEqual({ 'f-team': ['mai'] })
  })
})
