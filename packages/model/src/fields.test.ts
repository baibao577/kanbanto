import { describe, expect, it } from 'vitest'
import { describeChanges } from './activity'
import { applyChanges, invertChanges } from './changes'
import { execute, type Command } from './commands'
import {
  carryCustom,
  checkValue,
  compareValues,
  matchFields,
  nameProblem,
  numberText,
  parseValue,
  planAdoption,
  tidyCustom,
  valuePlain,
  valueText,
  type BoardField,
  type FieldDef,
} from './fields'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import { emptyBoard, exampleData } from './sample'
import { BoardDataSchema, CommandSchema } from './schema'
import { parseBoard } from './transfer'
import type { BoardData } from './types'

const NOW = '2026-10-05T10:00:00.000Z'
let n = 0
const ctx = (data: BoardData) => ({ now: NOW, newId: () => `new-${++n}`, idx: indexFor(data) })
function exec(data: BoardData, cmd: Command) {
  const r = execute(data, cmd, ctx(data))
  if ('error' in r) throw new Error(r.error)
  return { data: applyChanges(data, r.changes), changes: r.changes }
}
const refusal = (data: BoardData, cmd: Command) => {
  const r = execute(data, cmd, ctx(data))
  return 'error' in r ? r.error : null
}

const company: BoardField = { id: 'f-company', name: 'Company', type: 'text' }
const site: BoardField = { id: 'f-site', name: 'Site', type: 'text', format: 'link' }
const value: BoardField = { id: 'f-value', name: 'Value', type: 'number', unit: '฿', decimals: 0, sum: true }
const close: BoardField = { id: 'f-close', name: 'Close date', type: 'date' }
const stage: BoardField = {
  id: 'f-stage',
  name: 'Stage',
  type: 'choice',
  front: true,
  options: [
    { id: 'lead', name: 'Lead', color: 'gray' },
    { id: 'won', name: 'Won', color: 'green' },
    { id: 'old', name: 'Parked', color: 'amber', archived: true },
  ],
}
const signed: BoardField = { id: 'f-signed', name: 'Signed', type: 'checkbox' }
const FIELDS = [company, site, value, close, stage, signed]
const board = (): BoardData => ({ ...exampleData('b1'), fields: FIELDS })
const set = (data: BoardData, id: string, custom: Record<string, string | number | boolean | string[] | null>) =>
  exec(data, { type: 'task.update', id, fields: { custom } })

describe('field types', () => {
  it('check a value and tidy it, each in its own way', () => {
    expect(checkValue(company, '  Acme  ')).toEqual({ value: 'Acme' })
    expect(checkValue(company, '   ')).toEqual({ value: undefined })
    expect(checkValue(company, 'x'.repeat(501))).toHaveProperty('error')
    expect(checkValue(site, `https://example.com/${'x'.repeat(600)}`)).toHaveProperty('value')
    expect(checkValue(company, 12)).toHaveProperty('error')

    expect(checkValue(value, 12000.5)).toEqual({ value: 12000.5 })
    expect(checkValue(value, Number.NaN)).toHaveProperty('error')
    expect(checkValue(value, '12')).toHaveProperty('error')

    expect(checkValue(close, '2026-10-31')).toEqual({ value: '2026-10-31' })
    expect(checkValue(close, '2026-10-31T14:30:00+07:00')).toEqual({ value: '2026-10-31T07:30:00Z' })
    expect(checkValue(close, '31/10/2026')).toHaveProperty('error')

    expect(checkValue(stage, 'won')).toEqual({ value: ['won'] })
    expect(checkValue(stage, ['won'])).toEqual({ value: ['won'] })
    expect(checkValue(stage, [])).toEqual({ value: undefined })
    expect(checkValue(stage, ['lead', 'won'])).toHaveProperty('error')
    expect(checkValue(stage, 'nope')).toHaveProperty('error')

    expect(checkValue(signed, true)).toEqual({ value: true })
    expect(checkValue(signed, false)).toEqual({ value: undefined })
    expect(checkValue(signed, 'yes')).toHaveProperty('error')
    expect(checkValue(signed, null)).toEqual({ value: undefined })
  })

  it('an archived option can’t be picked, but a card that has it keeps it', () => {
    expect(checkValue(stage, 'old')).toEqual({ error: '“Parked” can’t be picked any more.' })
    expect(checkValue(stage, ['old'], true)).toEqual({ value: ['old'] })
    // What no longer fits is dropped, not refused, when a record comes back from somewhere.
    expect(checkValue(stage, ['gone'], true)).toEqual({ value: undefined })
    expect(tidyCustom({ 'f-stage': ['old'], 'f-value': 'lots' as never, 'f-company': 'Acme', 'f-left': 'x' }, FIELDS)).toEqual({
      'f-company': 'Acme',
      'f-stage': ['old'],
    })
    expect(tidyCustom({ 'f-left': 'x' }, FIELDS)).toBeUndefined()
  })

  it('read a value as it was typed or said', () => {
    expect(parseValue(value, '12,000')).toEqual({ value: 12000 })
    expect(parseValue(value, 'lots')).toHaveProperty('error')
    expect(parseValue(stage, 'WON')).toEqual({ value: ['won'] })
    expect(parseValue(stage, 'Parked')).toEqual({ error: 'There’s no option “Parked”. The options are: Lead, Won.' })
    expect(parseValue(signed, 'yes')).toEqual({ value: true })
    expect(parseValue(signed, 'no')).toEqual({ value: undefined })
    expect(parseValue(company, null)).toEqual({ value: undefined })
  })

  it('show a value in words, and put values in order', () => {
    expect(numberText(value, 12000)).toBe('฿12,000')
    expect(numberText({ unit: '%' }, 12.5)).toBe('12.5%')
    expect(numberText({ unit: 'h', decimals: 1 }, 3)).toBe('3.0 h')
    expect(valueText(stage, ['won'])).toBe('Won')
    expect(valueText(signed, true)).toBe('yes')
    expect(valuePlain(stage, ['won'])).toBe('Won')
    expect(valuePlain(value, 5)).toBe(5)

    expect(compareValues(value, 2, 10)).toBeLessThan(0)
    expect(compareValues(close, '2026-10-31', '2026-10-29T23:00:00Z')).toBeGreaterThan(0)
    // By the options' order, not their names; and nothing always goes last.
    expect(compareValues(stage, ['won'], ['lead'])).toBeGreaterThan(0)
    expect(compareValues(company, undefined, 'Acme')).toBeGreaterThan(0)
  })

  it('names: needed, not too long, and not something every card already has', () => {
    expect(nameProblem('Stage')).toBeNull()
    expect(nameProblem('  ')).toMatch(/needs a name/)
    expect(nameProblem(' Due ')).toMatch(/already has/)
    expect(nameProblem('Due', 'option')).toBeNull()
    expect(nameProblem('x'.repeat(61))).toMatch(/too long/)
  })
})

describe('values on cards', () => {
  it('sets the fields named and leaves the others', () => {
    let { data } = set(board(), 'A3', { 'f-company': 'Acme', 'f-value': 12000 })
    data = set(data, 'A3', { 'f-stage': 'won' as never, 'f-signed': true }).data
    expect(data.tasks.A3.custom).toEqual({ 'f-company': 'Acme', 'f-signed': true, 'f-stage': ['won'], 'f-value': 12000 })
    // Clearing one: null, or what counts as empty for its type. The last one gone leaves no `custom` at all.
    data = set(data, 'A3', { 'f-company': null, 'f-signed': false, 'f-value': null }).data
    expect(data.tasks.A3.custom).toEqual({ 'f-stage': ['won'] })
    data = set(data, 'A3', { 'f-stage': [] }).data
    expect(data.tasks.A3.custom).toBeUndefined()
    // A new card can come with values.
    const made = exec(data, { type: 'task.create', id: 'N1', parentId: null, fields: { title: 'New', custom: { 'f-value': 5 } } })
    expect(made.data.tasks.N1.custom).toEqual({ 'f-value': 5 })
  })

  it('refuses a field the board doesn’t use, and a value that doesn’t fit', () => {
    expect(refusal(board(), { type: 'task.update', id: 'A3', fields: { custom: { 'f-other': 'x' } } })).toBe('That field is no longer on this board.')
    expect(refusal(board(), { type: 'task.update', id: 'A3', fields: { custom: { 'f-value': 'lots' } } })).toBe('Value: That isn’t a number.')
    expect(refusal(board(), { type: 'task.update', id: 'A3', fields: { custom: { 'f-stage': ['old'] } } })).toMatch(/can’t be picked any more/)
    expect(CommandSchema.safeParse({ type: 'task.update', id: 'A3', fields: { custom: { 'f-value': { a: 1 } } } }).success).toBe(false)
    expect(CommandSchema.safeParse({ type: 'tasks.clearField', fieldId: 'f-value' }).success).toBe(true)
  })

  it('a value change is work on the card; undo and redo put it back and forth', () => {
    const start = board()
    const { data: after, changes } = set(start, 'A3', { 'f-company': 'Acme' })
    expect(after.tasks.A3.activeAt).toBe(NOW)
    const undo = invertChanges(after, changes, NOW)
    const { data: undone, changes: undoing } = exec(after, { type: 'records.restore', changes: undo })
    expect(undone.tasks.A3.custom).toBeUndefined()
    const { data: redone } = exec(undone, { type: 'records.restore', changes: invertChanges(undone, undoing, NOW) })
    expect(redone.tasks.A3.custom).toEqual({ 'f-company': 'Acme' })
  })

  it('undo never brings back a value for a field the board stopped using, or an option that’s gone', () => {
    const { data: filled } = set(board(), 'A3', { 'f-company': 'Acme', 'f-stage': 'won' as never })
    const { data: renamed, changes } = exec(filled, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    const undo = invertChanges(renamed, changes, NOW)
    // Meanwhile Company left the board, and Won was deleted.
    const now: BoardData = { ...renamed, fields: [{ ...stage, options: stage.options!.filter((o) => o.id !== 'won') }] }
    const { data: undone } = exec(now, { type: 'records.restore', changes: undo })
    expect(undone.tasks.A3.title).toBe('Deploy')
    expect(undone.tasks.A3.custom).toBeUndefined()

    // The same for a card that's archived, and for one coming out of the archive.
    const { data: put } = exec(filled, { type: 'task.archive', id: 'A3' })
    expect(put.archived!.A3.custom).toEqual({ 'f-company': 'Acme', 'f-stage': ['won'] })
    const { data: back } = exec({ ...put, fields: [stage] }, { type: 'task.restore', id: 'A3' })
    expect(back.tasks.A3.custom).toEqual({ 'f-stage': ['won'] })
    const { data: deleted, changes: deleting } = exec({ ...put, fields: [stage] }, { type: 'task.delete', id: 'A3' })
    const { data: again } = exec({ ...deleted, fields: [company] }, { type: 'records.restore', changes: invertChanges(deleted, deleting, NOW) })
    expect(again.archived!.A3.custom).toEqual({ 'f-company': 'Acme' })
  })

  it('clears a field on every card at once, without making them look worked on, and that can be undone', () => {
    let data = set(board(), 'A3', { 'f-value': 1, 'f-company': 'Acme' }).data
    data = set(data, 'A1', { 'f-value': 2 }).data
    const aged = { ...data, tasks: { ...data.tasks, A1: { ...data.tasks.A1, activeAt: '2026-01-01T00:00:00.000Z' } } }
    const { data: cleared, changes } = exec(aged, { type: 'tasks.clearField', fieldId: 'f-value' })
    expect(changes).toHaveLength(2)
    expect(cleared.tasks.A3.custom).toEqual({ 'f-company': 'Acme' })
    expect(cleared.tasks.A1.custom).toBeUndefined()
    expect(cleared.tasks.A1.activeAt).toBe('2026-01-01T00:00:00.000Z')
    expect(describeChanges(aged, changes, { type: 'tasks.clearField', fieldId: 'f-value' })).toEqual([{ text: 'cleared Value on 2 cards' }])
    const { data: undone } = exec(cleared, { type: 'records.restore', changes: invertChanges(cleared, changes, NOW) })
    expect(undone.tasks.A1.custom).toEqual({ 'f-value': 2 })
    expect(refusal(board(), { type: 'tasks.clearField', fieldId: 'f-nope' })).toMatch(/no longer on this board/)
  })

  it('the activity log says what was set, in words', () => {
    const start = board()
    const say = (data: BoardData, custom: Parameters<typeof set>[2]) => {
      const r = set(data, 'A3', custom)
      return { data: r.data, lines: describeChanges(data, r.changes).map((i) => i.text) }
    }
    const a = say(start, { 'f-value': 12000, 'f-stage': 'won' as never })
    expect(a.lines).toEqual(['set Value of “Deploy” to ฿12,000', 'set Stage of “Deploy” to Won'])
    expect(say(a.data, { 'f-value': null }).lines).toEqual(['cleared Value of “Deploy”'])
    expect(say(a.data, { 'f-company': 'x'.repeat(100) }).lines[0]).toHaveLength('set Company of “Deploy” to '.length + 60)
    expect(say(a.data, { 'f-value': 12000 }).lines).toEqual([])
  })

  it('a board keeps its fields through changes, and a file with them reads back', () => {
    const { data } = set(board(), 'A3', { 'f-company': 'Acme' })
    expect(data.fields).toBe(FIELDS)
    const file = { app: 'kanbanto', format: 3, data: { ...data, fields: [...FIELDS, { id: 'f-new', name: 'Map', type: 'location' }] } }
    const read = parseBoard(JSON.stringify(file), 'mine')
    // A field of a type this version doesn't know is left out; a value for a field that isn't there is dropped.
    expect(read.fields.map((f) => f.id)).toEqual(FIELDS.map((f) => f.id))
    expect(read.tasks.A3.custom).toEqual({ 'f-company': 'Acme' })
    const stray = { ...file, data: { ...data, fields: [value], tasks: { ...data.tasks, A1: { ...data.tasks.A1, custom: { 'f-value': 'x' } } } } }
    const tidied = parseBoard(JSON.stringify(stray), 'mine')
    expect(tidied.tasks.A3.custom).toBeUndefined()
    expect(tidied.tasks.A1.custom).toBeUndefined()
    // A file from before fields has none.
    const { fields: _none, ...old } = exampleData('x')
    expect(BoardDataSchema.parse(old).fields).toEqual([])
  })
})

describe('carrying values to other fields', () => {
  const there: FieldDef[] = [
    company,
    { id: 't-stage', name: ' stage ', type: 'choice', options: [{ id: 'w', name: 'WON', color: 'green' }] },
    { id: 't-value', name: 'Value', type: 'text' },
  ]

  it('a card moving to another board takes the values that have somewhere to go', () => {
    const { map, unmatched } = matchFields(FIELDS, there)
    expect(unmatched.map((f) => f.name)).toEqual(['Site', 'Value', 'Close date', 'Signed'])
    expect(carryCustom({ 'f-company': 'Acme', 'f-stage': ['won'], 'f-value': 3 }, map)).toEqual({ 'f-company': 'Acme', 't-stage': ['w'] })
    // An option the other field doesn't have can't come along.
    expect(carryCustom({ 'f-stage': ['lead'] }, map)).toBeUndefined()

    const source = set(set(board(), 'A2', { 'f-company': 'Acme', 'f-value': 3 }).data, 'A2a', { 'f-stage': 'lead' as never }).data
    const target: BoardData = { ...emptyBoard('dst', 'Other', NOW), fields: there }
    const plan = planMove(source, target, 'A2', {}, { now: NOW, newId: () => `m${++n}` })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.summary.droppedFields.sort()).toEqual(['Stage', 'Value'])
    const moved = applyChanges(target, plan.target)
    expect(moved.tasks[plan.ids.get('A2')!].custom).toEqual({ 'f-company': 'Acme' })
    expect(moved.tasks[plan.ids.get('A2a')!].custom).toBeUndefined()
    // Nothing to say when nothing is left behind.
    const quiet = planMove(board(), target, 'A3', {}, { now: NOW, newId: () => `m${++n}` })
    expect('error' in quiet ? null : quiet.summary.droppedFields).toEqual([])
  })

  it('fields arriving in another library: used if it has them, added if you manage it, lost otherwise', () => {
    const library = [
      { ...company, id: 'l-company' },
      { id: 'l-stage', name: 'Stage', type: 'choice' as const, options: [{ id: 'won', name: 'Lead', color: 'gray' as const }] },
      { id: 'l-value', name: 'value', type: 'text' as const },
      { id: 'l-signed', name: 'Signed', type: 'checkbox' as const, archived: true },
    ]
    let id = 0
    const newId = () => `x${++id}`
    const plan = planAdoption(library, [company, stage, value, signed, close], { canAdd: true, room: 10, newId })
    expect(plan.map.get('f-company')).toEqual({ id: 'l-company' })
    // Lead is there; Won is added to the library's Stage (under a new id: "won" is taken there); Parked is archived, so it isn't.
    expect(plan.addOptions.get('l-stage')).toEqual([{ id: 'x1', name: 'Won', color: 'green' }])
    expect([...plan.map.get('f-stage')!.options!]).toEqual([
      ['lead', 'won'],
      ['won', 'x1'],
    ])
    // A name taken by another type, or by an archived field, gets a number after it.
    expect(plan.add.map((f) => [f.name, f.type])).toEqual([
      ['Value (2)', 'number'],
      ['Signed (2)', 'checkbox'],
      ['Close date', 'date'],
    ])
    expect(plan.lose).toEqual([])
    expect(carryCustom({ 'f-stage': ['won'], 'f-value': 3 }, plan.map)).toEqual({ 'l-stage': ['x1'], [plan.add[0].id]: 3 })

    // Not your library, or no room: what it doesn't have can't come along.
    const guest = planAdoption(library, [company, stage, value, close], { canAdd: false, room: 10, newId })
    expect(guest.add).toEqual([])
    expect(guest.lose).toEqual(['Stage: Won', 'Value', 'Close date'])
    expect(planAdoption(library, [value, close], { canAdd: true, room: 1, newId }).lose).toEqual(['Close date'])
    // Brought in a second time, the ones that were given a number are found again.
    const second = planAdoption([...library, ...plan.add], [value, signed, close], { canAdd: true, room: 10, newId })
    expect(second.add).toEqual([])
    expect(second.map.get('f-value')).toEqual({ id: plan.add[0].id })
    // The same field (a board coming back to where it was) is simply itself.
    expect(planAdoption([company], [company], { canAdd: false, room: 0, newId }).map.get('f-company')).toEqual({ id: 'f-company' })
  })
})
