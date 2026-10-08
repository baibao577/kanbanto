import { describe, expect, it } from 'vitest'
import { bigBoard } from './bigBoard'
import { applyChanges, invertChanges } from './changes'
import { execute, type Command } from './commands'
import type { BoardField, FieldMap } from './fields'
import { indexFor } from './indexer'
import type { Change } from './records'
import {
  ASSIGNEE,
  cardsOf,
  countsFor,
  describeRule,
  evaluateRule,
  evaluateRules,
  firings,
  hasConditions,
  isPlainCount,
  knownRules,
  limitOn,
  limitsOf,
  listOf,
  MAX_RULES,
  momentOf,
  namesPeople,
  remapRule,
  ruleProblem,
  shortName,
  tellOn,
  toldNames,
  whensOf,
  type BoardRule,
  type LimitRule,
  type WhenRule,
} from './rules'
import { exampleData } from './sample'
import { BoardDataSchema, BoardRuleSchema } from './schema'
import { exportFile, readBoardFile } from './transfer'
import type { BoardData } from './types'

const NOW = '2026-10-08T03:00:00.000Z'
const ID = (n: number) => `01a11a5c-609c-7236-b2bd-0c3a10370e${String(40 + n)}`
const hours: BoardField = { id: 'f-hours', name: 'Estimate', type: 'number', unit: 'h', decimals: 0, sum: true }
const stage: BoardField = {
  id: 'f-stage',
  name: 'Stage',
  type: 'choice',
  options: [
    { id: 'o-new', name: 'New', color: 'blue' },
    { id: 'o-won', name: 'Won', color: 'green' },
  ],
}
const when: BoardField = { id: 'f-when', name: 'Close date', type: 'date' }
const who: BoardField = { id: 'f-who', name: 'Reviewer', type: 'person' }

/**
 * The example board (a parent follows its subtasks), with Mai, Ton and Ploy on it. Its cards without subtasks:
 * Backlog A4 (Mai), B2 (Ploy), C1, C2 · To Do A2b (Ton), A3 (Mai) · Doing A2a (Ton), B1 (Ploy) · Done A1 (Mai).
 */
function board(custom: Record<string, Record<string, unknown>> = {}): BoardData {
  const data = exampleData('b1')
  return {
    ...data,
    fields: [hours, stage, when, who],
    tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, custom[t.id] ? { ...t, custom: custom[t.id] as never } : t])),
  }
}
const limit = (over: Partial<LimitRule> = {}, list = 'doing', max = 3): LimitRule => ({ ...limitOn(ID(1), list, 'derived', max), ...over })
const stands = (data: BoardData, rule: LimitRule) => {
  const s = evaluateRule(indexFor(data), rule, data.labels)
  return s.problem ? s.problem : s.groups.map((g) => `${g.person || 'all'} ${g.value} ${g.standing}`).join(', ')
}
const run = (data: BoardData, command: Command) => {
  const r = execute(data, command, { now: NOW, newId: () => 'n1', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return applyChanges(data, r.changes)
}

describe('a limit', () => {
  it('counts the cards of a list against its number: room, full, over', () => {
    const data = board()
    expect(stands(data, limit({}, 'doing', 3))).toBe('all 2 ok')
    expect(stands(data, limit({}, 'doing', 2))).toBe('all 2 near')
    expect(stands(data, limit({}, 'doing', 1))).toBe('all 2 over')
    expect(stands(data, limit({}, 'backlog', 3))).toBe('all 4 over')
    expect(stands(data, limit({}, 'done', 0))).toBe('all 1 over')
    // Two lists together, and the whole board.
    expect(stands(data, limit({ cards: { statuses: ['todo', 'doing'] } }, '', 4))).toBe('all 4 near')
    expect(stands(data, limit({ cards: {} }, '', 10))).toBe('all 9 ok')
    // A least, where one is kept.
    expect(stands(data, { ...limit({}, 'todo'), max: undefined, min: 3 })).toBe('all 2 under')
  })

  it('counts the cards a board shows: without subtasks, the top ones, or every one', () => {
    const data = board()
    expect(countsFor('derived')).toBe('leaves')
    expect(countsFor('manual')).toBe('topLevel')
    const idx = indexFor(data)
    expect(cardsOf(idx, limit({ counts: 'leaves' })).sort()).toEqual(['A2a', 'B1'])
    // (Launch website and Event are "doing" because a subtask of each is.)
    expect(cardsOf(idx, limit({ counts: 'topLevel' })).sort()).toEqual(['A', 'B'])
    expect(cardsOf(idx, limit({ counts: 'all' })).sort()).toEqual(['A', 'A2', 'A2a', 'B', 'B1'])
    expect(listOf(limit())).toBe('doing')
    expect(listOf(limit({ cards: { statuses: ['todo', 'doing'] } }))).toBeNull()
    expect(listOf(limit({ cards: {} }))).toBeNull()
  })

  it('takes the Filter menu’s conditions: people, labels, priority, the board’s fields', () => {
    const data = run(board({ A2a: { 'f-stage': ['o-won'] }, B1: { 'f-stage': ['o-new'] } }), {
      type: 'task.update',
      id: 'B1',
      fields: { priority: 'urgent' },
    })
    const of = (cards: LimitRule['cards']) => cardsOf(indexFor(data), limit({ cards })).sort()
    expect(of({ statuses: ['doing'], priorities: ['urgent'] })).toEqual(['B1'])
    expect(of({ statuses: ['doing'], priorities: [''] })).toEqual(['A2a'])
    expect(of({ labels: ['brand'] })).toEqual(['A2b', 'C1'])
    expect(of({ assignees: ['ton'] })).toEqual(['A2a', 'A2b'])
    expect(of({ assignees: [''] })).toEqual(['C1', 'C2'])
    expect(of({ fields: { 'f-stage': { in: ['o-won'] } } })).toEqual(['A2a'])
    expect(of({ statuses: ['doing'], fields: { 'f-stage': { notIn: ['o-won'] } } })).toEqual(['B1'])
  })

  it('holds each person by themselves, by who a card is assigned to', () => {
    const data = board()
    const all = limit({ cards: {}, per: 'person' }, '', 2)
    // Mai has A1, A3, A4; Ton A2a, A2b; Ploy B1, B2. Nobody's cards (C1, C2) are nobody's load.
    expect(stands(data, all)).toBe('mai 3 over, ploy 2 near, ton 2 near')
    expect(evaluateRule(indexFor(data), all, data.labels).standing).toBe('over')
    expect(stands(data, limit({ per: 'person' }, 'doing', 2))).toBe('ploy 1 ok, ton 1 ok')
    // Someone who left the board isn't held to anything.
    const left = { ...data, members: data.members.filter((m) => m.id !== 'mai') }
    expect(stands(left, all)).toBe('ploy 2 near, ton 2 near')
    expect(stands(data, limit({ per: 'person' }, 'done', 5))).toBe('mai 1 ok')
  })

  it('adds up a number field: a card without one adds nothing, and nine tenths is nearly full', () => {
    const data = board({ A2a: { 'f-hours': 16 }, B1: { 'f-hours': 20 }, A2b: { 'f-hours': 6 }, A2: { 'f-hours': 2 } })
    const sum = (max: number, over: Partial<LimitRule> = {}) =>
      stands(data, limit({ measure: { by: 'field', field: 'f-hours' }, ...over }, 'doing', max))
    expect(sum(50)).toBe('all 36 ok')
    expect(sum(40)).toBe('all 36 near')
    expect(sum(36)).toBe('all 36 near')
    expect(sum(35)).toBe('all 36 over')
    expect(sum(18, { per: 'person' })).toBe('ploy 20 over, ton 16 ok')
    // To Do: only Logo has a number; Deploy adds nothing.
    expect(stands(data, limit({ measure: { by: 'field', field: 'f-hours' } }, 'todo', 40))).toBe('all 6 ok')
    // Where the top-level cards count, a card's number is its own with its subtasks' (as a list's totals are).
    expect(sum(100, { counts: 'topLevel' })).toBe('all 44 ok')
    // Every card: each number once, on the card that holds it.
    expect(sum(100, { counts: 'all' })).toBe('all 38 ok')
  })

  it('is said in words', () => {
    const data = board()
    const says = (r: Partial<LimitRule>, list = 'doing', max = 3) => describeRule(limit(r, list, max), data)
    expect(says({})).toBe('At most 3 cards in Doing')
    expect(says({}, 'doing', 1)).toBe('At most 1 card in Doing')
    expect(says({ per: 'person' }, 'doing', 2)).toBe('At most 2 cards for each person in Doing')
    expect(says({ measure: { by: 'field', field: 'f-hours' } }, 'todo', 40)).toBe('At most 40 h of Estimate in To Do')
    expect(says({ cards: { statuses: ['todo', 'doing'] } })).toBe('At most 3 cards in To Do or Doing')
    expect(says({ cards: { statuses: ['backlog', 'todo', 'doing'] } })).toBe('At most 3 cards in Backlog, To Do or Doing')
    expect(says({ cards: {} })).toBe('At most 3 cards on the board')
    expect(says({ cards: { statuses: ['doing'], priorities: ['urgent'], labels: ['ui'] } })).toBe(
      'At most 3 cards in Doing where Labels is ui and Priority is Urgent',
    )
    expect(says({ cards: { statuses: ['doing'], fields: { 'f-stage': { in: ['o-won'] } } } })).toMatch(/^At most 3 cards in Doing where Stage is /)
    expect(describeRule({ ...limit(), max: undefined, min: 2 }, data)).toBe('At least 2 cards in Doing')
  })
})

describe('a limit where there is little room', () => {
  it('a plain count sits beside a list’s name; any other limit needs a few words with its numbers', () => {
    const data = board()
    expect(isPlainCount(limit())).toBe(true)
    expect(isPlainCount(limit({ per: 'person' }))).toBe(true)
    expect(isPlainCount(limit({ measure: { by: 'field', field: 'f-hours' } }))).toBe(false)
    expect(isPlainCount(limit({ cards: { statuses: ['doing'], priorities: ['urgent'] } }))).toBe(false)
    expect(isPlainCount(limit({ name: 'Oven' }))).toBe(false)
    expect(hasConditions(limit())).toBe(false)
    expect(hasConditions(limit({ cards: { statuses: ['doing'], labels: ['ui'] } }))).toBe(true)
    // The words: its own name, else the field it adds up and what its conditions pick.
    const short = (r: Partial<LimitRule>) => shortName(limit(r), data)
    expect(short({})).toBe('')
    expect(short({ name: 'Roofing crew', cards: { statuses: ['doing'], labels: ['ui'] } })).toBe('Roofing crew')
    expect(short({ measure: { by: 'field', field: 'f-hours' } })).toBe('Estimate')
    expect(short({ cards: { statuses: ['doing'], fields: { 'f-stage': { in: ['o-won'] } } } })).toBe('Won')
    expect(short({ cards: { statuses: ['doing'], priorities: ['urgent'] } })).toBe('Urgent')
    expect(
      short({ measure: { by: 'field', field: 'f-hours' }, cards: { statuses: ['doing'], fields: { 'f-stage': { in: ['o-new', 'o-won'] } } } }),
    ).toBe('Estimate, New, Won')
    // A name is a few words, not nothing and not padded.
    expect(BoardRuleSchema.safeParse(limit({ name: 'Oven' })).success).toBe(true)
    for (const name of ['', '  ', ' Oven', 'x'.repeat(61)]) expect(BoardRuleSchema.safeParse(limit({ name })).success).toBe(false)
  })
})

describe('a rule that names something that is gone', () => {
  it('is never worked out with what is left of it, and says why', () => {
    const data = board()
    const idx = indexFor(data)
    const why = (r: Partial<LimitRule>) => ruleProblem(idx, limit(r), data.labels)
    expect(why({})).toBeNull()
    expect(why({ cards: { statuses: ['nowhere'] } })).toBe('Its list is gone.')
    expect(why({ cards: { statuses: ['doing', 'nowhere'] } })).toBe('One of its lists is gone.')
    expect(why({ cards: { labels: ['gone'] } })).toBe('A label it names is gone.')
    expect(why({ cards: { assignees: ['zed'] } })).toBe('Someone it names is no longer on the board.')
    expect(why({ cards: { assignees: [''] } })).toBeNull()
    expect(why({ cards: { fields: { 'f-gone': { has: true } } } })).toBe('A field it names is no longer on the board.')
    expect(why({ measure: { by: 'field', field: 'f-gone' } })).toBe('The field it adds up is no longer on the board.')
    expect(why({ measure: { by: 'field', field: 'f-stage' } })).toBe('The field it adds up isn’t a number.')
    // What would say something different to different people, or on different days.
    expect(why({ cards: { assignees: ['me'] } })).toBe('A rule can’t be about “me”.')
    expect(why({ cards: { fields: { 'f-who': { in: ['me'] } } } })).toBe('A rule can’t be about “me”.')
    expect(why({ cards: { fields: { 'f-when': { date: 'week' } } } })).toBe('A rule can’t be about a date.')
    expect(why({ cards: { due: 'week' } as never })).toBe('It asks for something a rule can’t.')
    expect(ruleProblem(idx, { ...limit(), max: undefined }, data.labels)).toBe('It has no number.')
    // Not worked out: no numbers at all, rather than a wider limit's.
    const state = evaluateRule(idx, limit({ cards: { statuses: ['doing'], labels: ['gone'] } }), data.labels)
    expect(state).toMatchObject({ problem: 'A label it names is gone.', groups: [], standing: 'ok' })
  })

  it('mends itself when the thing comes back: a list deleted and the delete undone', () => {
    const data = { ...board(), rules: [limit({}, 'doing', 1)] }
    const without = run(data, { type: 'column.delete', id: 'doing', moveTo: 'todo' })
    expect(without.rules).toEqual(data.rules)
    expect(stands(without, without.rules![0] as LimitRule)).toBe('Its list is gone.')
    expect(stands(data, data.rules[0])).toBe('all 2 over')
  })
})

/** A rule that tells Mai about a list's arrivals (or, with `on: 'leaves'`, about what leaves it). */
const tell = (over: Partial<WhenRule> = {}, list = 'doing'): WhenRule => ({
  ...tellOn(ID(5), list, 'derived'),
  then: [{ do: 'tell', who: ['mai'] }],
  ...over,
})
/** What a change makes of a rule's cards: "arrived / left" ("-" for none), and the board after it. */
function fires(data: BoardData, change: Command | Change[], rule: WhenRule): [string, BoardData] {
  let changes = change as Change[]
  if (!Array.isArray(change)) {
    const r = execute(data, change, { now: NOW, newId: () => 'n1', idx: indexFor(data) })
    if ('error' in r) throw new Error(r.error)
    changes = r.changes
  }
  const after = applyChanges(data, changes)
  const touched = changes.filter((c) => c.entity === 'task').map((c) => c.id)
  const f = firings({ idx: indexFor(data), labels: data.labels }, { idx: indexFor(after), labels: after.labels }, rule, touched)
  return [`${f.entered.sort().join(' ') || '-'} / ${f.left.sort().join(' ') || '-'}`, after]
}
const fired = (data: BoardData, change: Command | Change[], rule: WhenRule) => fires(data, change, rule)[0]

describe('a rule that tells people when a card arrives or leaves', () => {
  it('a card arrives however it comes to be one of the rule’s cards: moved in, made there, brought back', () => {
    const data = board()
    expect(fired(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, tell())).toBe('A3 / -')
    expect(fired(data, { type: 'task.create', parentId: null, fields: { title: 'New', status: 'doing' } }, tell())).toBe('n1 / -')
    const [gone, archived] = fires(data, { type: 'task.archive', id: 'B1' }, tell())
    expect(gone).toBe('- / B1')
    expect(fired(archived, { type: 'task.restore', id: 'B1' }, tell())).toBe('B1 / -')
    expect(fired(data, { type: 'task.delete', id: 'B1' }, tell())).toBe('- / B1')
    // The same change, to a rule about the list it left.
    expect(fired(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, tell({}, 'todo'))).toBe('- / A3')
    // An undo is a change like another: the card is back where it was.
    const r = execute(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, { now: NOW, newId: () => 'n1', idx: indexFor(data) })
    if ('error' in r) throw new Error(r.error)
    const moved = applyChanges(data, r.changes)
    expect(fired(moved, invertChanges(moved, r.changes, NOW), tell())).toBe('- / A3')
  })

  it('a change that leaves a card where it was is neither: a new title, another place in the same list', () => {
    const data = board()
    expect(fired(data, { type: 'task.update', id: 'B1', fields: { title: 'Send the invites' } }, tell())).toBe('- / -')
    expect(fired(data, { type: 'task.update', id: 'B1', fields: { assigneeId: 'ton' } }, tell())).toBe('- / -')
    expect(fired(data, { type: 'task.update', id: 'A3', fields: { status: 'todo' } }, tell({}, 'todo'))).toBe('- / -')
  })

  it('takes a limit’s conditions: a card changed so that it fits has arrived, with no list in it at all', () => {
    const data = board()
    const urgent = tell({ cards: { priorities: ['urgent'] } })
    const [made, after] = fires(data, { type: 'task.update', id: 'A3', fields: { priority: 'urgent' } }, urgent)
    expect(made).toBe('A3 / -')
    expect(fired(after, { type: 'task.update', id: 'A3', fields: { priority: 'high' } }, urgent)).toBe('- / A3')
    // Both at once: Ton's cards in Doing. Reassigned to Ton, B1 arrives though it never moved.
    const tons = tell({ cards: { statuses: ['doing'], assignees: ['ton'] } })
    expect(fired(data, { type: 'task.update', id: 'B1', fields: { assigneeId: 'ton' } }, tons)).toBe('B1 / -')
    expect(fired(data, { type: 'task.update', id: 'A2a', fields: { status: 'done' } }, tons)).toBe('- / A2a')
    expect(fired(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, tons)).toBe('- / -')
  })

  it('counts the cards its board shows: a parent that follows its subtasks arrives when they put it there', () => {
    const data = board()
    // Design (A2) has Homepage in Doing and Logo in To Do: with both done it shows in Done, without being written.
    const [, half] = fires(data, { type: 'task.update', id: 'A2a', fields: { status: 'done' } }, tell({}, 'done'))
    const last: Command = { type: 'task.update', id: 'A2b', fields: { status: 'done' } }
    expect(fired(half, last, tell({}, 'done'))).toBe('A2b / -')
    expect(fired(half, last, tell({ counts: 'all' }, 'done'))).toBe('A2 A2b / -')
    expect(fired(half, last, tell({ counts: 'topLevel' }, 'done'))).toBe('- / -')
    // (Half done, Design showed in Doing: that is the list it left.)
    expect(fired(half, last, tell({ counts: 'all', on: 'leaves' }, 'todo'))).toBe('- / A2b')
    expect(fired(half, last, tell({ counts: 'all', on: 'leaves' }))).toBe('- / A2')
    // On a board where cards keep their own list, a subtask moved into the list isn't one of its cards.
    const flat: BoardData = { ...data, board: { ...data.board, mode: 'manual' } }
    const top = { ...tellOn(ID(6), 'doing', 'manual'), then: [{ do: 'tell' as const, who: ['mai'] }] }
    expect(top.counts).toBe('topLevel')
    expect(fired(flat, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, top)).toBe('- / -')
    expect(fired(flat, { type: 'task.update', id: 'C', fields: { status: 'doing' } }, top)).toBe('C / -')
  })

  it('a card that only gains or loses subtasks has neither arrived nor left', () => {
    const data = board()
    // Deploy (A3) is in To Do without subtasks. Given one there, the subtask arrived; Deploy is where it was.
    const [made, parent] = fires(data, { type: 'task.create', parentId: 'A3', fields: { title: 'Step', status: 'todo' } }, tell({}, 'todo'))
    expect(made).toBe('n1 / -')
    // Without it again, Deploy is a card without subtasks once more: not an arrival.
    expect(fired(parent, { type: 'task.delete', id: 'n1' }, tell({}, 'todo'))).toBe('- / n1')
  })

  it('says nothing when it can’t be worked out, before the change or after it', () => {
    const data = board()
    const gone: Command = { type: 'column.delete', id: 'doing', moveTo: 'todo' }
    const [left, without] = fires(data, gone, tell({ on: 'leaves' }))
    expect(left).toBe('- / -')
    // (The cards did arrive in the list they were put in.)
    expect(fired(data, gone, tell({}, 'todo'))).toBe('A2a B1 / -')
    // The list brought back by an undo isn't every card in it arriving.
    const r = execute(data, gone, { now: NOW, newId: () => 'n1', idx: indexFor(data) })
    if ('error' in r) throw new Error(r.error)
    expect(fired(without, invertChanges(without, r.changes, NOW), tell())).toBe('- / -')
    // A rule with nobody to tell: it names nobody, or the people it names have all left.
    const idx = indexFor(data)
    expect(ruleProblem(idx, tell(), data.labels)).toBeNull()
    expect(ruleProblem(idx, tell({ then: [{ do: 'tell', who: [] }] }), data.labels)).toBe('It tells nobody.')
    expect(ruleProblem(idx, tell({ then: [{ do: 'tell', who: ['gone'] }] }), data.labels)).toBe('Nobody it tells is on the board any more.')
    expect(ruleProblem(idx, tell({ then: [{ do: 'tell', who: ['gone', 'ton'] }] }), data.labels)).toBeNull()
    expect(ruleProblem(idx, tell({ then: [{ do: 'tell', who: [ASSIGNEE] }] }), data.labels)).toBeNull()
    expect(ruleProblem(idx, tell({ cards: { statuses: ['nope'] } }), data.labels)).toBe('Its list is gone.')
    expect(fired(data, { type: 'task.update', id: 'A3', fields: { status: 'doing' } }, tell({ then: [{ do: 'tell', who: ['gone'] }] }))).toBe('- / -')
  })

  it('is said in words: the rule, who it tells, and what happened to a card', () => {
    const data = { ...board(), fields: [hours, stage] }
    expect(describeRule(tell(), data)).toBe('When a card arrives in Doing, tell Mai')
    expect(describeRule(tell({ on: 'leaves', then: [{ do: 'tell', who: [ASSIGNEE] }] }), data)).toBe(
      'When a card leaves Doing, tell whoever it is assigned to',
    )
    const many = tell({
      cards: { statuses: ['todo', 'doing'], priorities: ['urgent'] },
      then: [{ do: 'tell', who: ['mai', 'gone', 'ton', ASSIGNEE] }],
    })
    expect(describeRule(many, data)).toBe(
      'When a card arrives in To Do or Doing where Priority is Urgent, tell Mai, Ton and whoever it is assigned to',
    )
    expect(toldNames(many, data)).toBe('Mai, Ton and whoever it is assigned to')
    expect(toldNames(tell({ then: [{ do: 'tell', who: ['gone'] }] }), data)).toBe('nobody')
    const anywhere = tell({ cards: { priorities: ['urgent'] } })
    expect(describeRule(anywhere, data)).toBe('When a card starts to be one where Priority is Urgent, tell Mai')
    expect(describeRule({ ...anywhere, on: 'leaves' }, data)).toBe('When a card stops being one where Priority is Urgent, tell Mai')
    expect(describeRule(tell({ cards: {} }), data)).toBe('When a card is added to the board, tell Mai')
    // After a card's title, in a notice.
    expect(momentOf(tell(), data)).toBe('arrived in Doing')
    expect(momentOf(tell({ on: 'leaves' }), data)).toBe('left Doing')
    expect(momentOf(many, data)).toBe('arrived in To Do or Doing')
    expect(momentOf(anywhere, data)).toBe('now fits Priority is Urgent')
    expect(momentOf({ ...anywhere, name: 'Urgent orders', on: 'leaves' }, data)).toBe('no longer fits “Urgent orders”')
    expect(momentOf(tell({ cards: {} }), data)).toBe('was added to the board')
    expect(momentOf(tell({ cards: {}, on: 'leaves' }), data)).toBe('left the board')
    expect(shortName(tell({ name: 'New quotes' }), data)).toBe('New quotes')
    expect(shortName(many, data)).toBe('Urgent')
  })

  it('is a rule of its board beside its limits, which only see limits', () => {
    const rules: BoardRule[] = [limit({}, 'doing', 1), tell()]
    const data = { ...board(), rules }
    expect(limitsOf(rules)).toEqual([rules[0]])
    expect(whensOf(rules)).toEqual([rules[1]])
    expect(evaluateRules(indexFor(data), data).map((s) => s.rule.id)).toEqual([rules[0].id])
    // A browser takes the board as it comes: a kind from a newer server is left out, not tripped over.
    expect(knownRules([...rules, { ...limit(), kind: 'check' } as never])).toEqual(rules)
    expect(knownRules(undefined)).toEqual([])
    // Read as a rule from a board's data, and only when it is one.
    const read = BoardDataSchema.parse({
      ...board(),
      rules: [
        tell(),
        tell({ then: [{ do: 'tell', who: [] }] }),
        { ...tell(), then: [{ do: 'show' }] },
        { ...tell(), on: 'waits' },
        { ...tell(), max: 3 },
        { ...tell(), then: [...tell().then, ...tell().then] },
        { ...tell(), cards: { due: 'week' } },
      ],
    })
    expect(read.rules).toEqual([tell()])
    expect(BoardRuleSchema.safeParse(tell({ name: 'New quotes', then: [{ do: 'tell', who: ['mai', ASSIGNEE] }] })).success).toBe(true)
    // In a board's file people aren't carried: a rule that tells any names people; "whoever it is assigned to" doesn't.
    expect(namesPeople(tell(), () => false)).toBe(true)
    expect(namesPeople(tell({ then: [{ do: 'tell', who: [ASSIGNEE] }] }), () => false)).toBe(false)
    // Its fields follow a merge the way a limit's do, and it stays the rule it was.
    const byStage = tell({ cards: { fields: { 'f-stage': { in: ['o-new'] } } } })
    const merge: FieldMap = new Map([['f-stage', { id: 'f-phase', options: new Map([['o-new', 'p-new']]) }]])
    expect(remapRule(byStage, merge, 'keep')).toEqual({ ...byStage, cards: { fields: { 'f-phase': { in: ['p-new'] } } } })
    expect(remapRule(byStage, new Map(), 'drop')).toBeNull()
  })
})

describe('a board’s rules', () => {
  it('are carried through every change to the board, which no command makes to them', () => {
    const rules = [limit()]
    const data = { ...board(), rules }
    const after = run(data, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    expect(after.rules).toBe(rules)
    expect(run(after, { type: 'task.delete', id: 'A3' }).rules).toBe(rules)
    // A board without any stays without the key.
    expect('rules' in run(board(), { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })).toBe(false)
  })

  it('are worked out once for a version of the board', () => {
    const data = { ...board(), rules: [limit({}, 'doing', 1), { ...limit({}, 'todo', 5), id: ID(2) }] }
    const idx = indexFor(data)
    const first = evaluateRules(idx, data)
    expect(first.map((s) => s.standing)).toEqual(['over', 'ok'])
    expect(evaluateRules(idx, data)).toBe(first)
    const next = run(data, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    expect(evaluateRules(indexFor(next), next)).not.toBe(first)
    expect(evaluateRules(indexFor(board()), board())).toEqual([])
  })

  it('are read from a board’s data as rules, and what isn’t one is left out', () => {
    const plain = board()
    expect(BoardDataSchema.parse(plain)).toEqual(plain)
    expect('rules' in BoardDataSchema.parse(plain)).toBe(false)
    const good = limit({ cards: { statuses: ['doing'], priorities: ['urgent'] } })
    const read = BoardDataSchema.parse({
      ...plain,
      rules: [
        good,
        { ...good, kind: 'when' },
        { ...good, cards: { due: 'week' } },
        { ...good, max: undefined },
        { ...good, then: [] },
        'nonsense',
        { ...good, extra: 1 },
      ],
    })
    expect(read.rules).toEqual([good])
    expect(BoardRuleSchema.safeParse({ ...good, min: 5, max: 3 }).success).toBe(false)
    expect(BoardRuleSchema.safeParse({ ...good, id: 'not-an-id' }).success).toBe(false)
    expect(BoardRuleSchema.safeParse({ ...good, max: -1 }).success).toBe(false)
    expect(MAX_RULES).toBe(20)
  })

  it('travel in a board’s file', () => {
    const data = { ...board(), rules: [limit()] }
    const file = exportFile(data)
    expect(file.data.rules).toEqual(data.rules)
    expect(readBoardFile(JSON.parse(JSON.stringify(file)), 'b9').rules).toEqual(data.rules)
  })

  it('follow their fields when those get other ids, and are never carried with a condition missing', () => {
    const rule = limit({
      measure: { by: 'field', field: 'f-hours' },
      cards: { statuses: ['doing'], fields: { 'f-stage': { in: ['o-new', 'o-won'] } } },
    })
    // Two fields merged into one: the field that goes is the kept one, its options by their new ids.
    const merge: FieldMap = new Map([
      [
        'f-stage',
        {
          id: 'f-phase',
          options: new Map([
            ['o-new', 'p-new'],
            ['o-won', 'p-won'],
          ]),
        },
      ],
    ])
    expect(remapRule(rule, merge, 'keep')).toEqual({
      ...rule,
      cards: { statuses: ['doing'], fields: { 'f-phase': { in: ['p-new', 'p-won'] } } },
    })
    // To another library: both fields have a place there.
    const move: FieldMap = new Map([
      [
        'f-stage',
        {
          id: 'g-stage',
          options: new Map([
            ['o-new', 'q-new'],
            ['o-won', 'q-won'],
          ]),
        },
      ],
      ['f-hours', { id: 'g-hours' }],
    ])
    expect(remapRule(rule, move, 'drop')).toMatchObject({
      measure: { by: 'field', field: 'g-hours' },
      cards: { fields: { 'g-stage': { in: ['q-new', 'q-won'] } } },
    })
    // The field it adds up has no place: not carried. Nor when a condition's field hasn't, or an option it picks.
    expect(remapRule(rule, new Map([['f-stage', move.get('f-stage')!]]), 'drop')).toBeNull()
    expect(remapRule(rule, new Map([['f-hours', { id: 'g-hours' }]]), 'drop')).toBeNull()
    expect(
      remapRule(
        rule,
        new Map([
          ['f-hours', { id: 'g-hours' }],
          ['f-stage', { id: 'g-stage', options: new Map([['o-new', 'q-new']]) }],
        ]),
        'drop',
      ),
    ).toBeNull()
    // A rule about no field is itself wherever it goes.
    expect(remapRule(limit(), new Map(), 'drop')).toEqual(limit())
    // People aren't carried over with a board's file: a rule that names any says so.
    expect(namesPeople(limit({ cards: { assignees: ['ton'] } }), () => false)).toBe(true)
    expect(namesPeople(limit({ cards: { assignees: [''] } }), () => false)).toBe(false)
    expect(namesPeople(limit({ cards: { fields: { 'f-who': { has: true } } } }), (f) => f === 'f-who')).toBe(true)
    expect(namesPeople(limit({ per: 'person' }), () => false)).toBe(false)
  })

  it('twenty of them on 3,000 cards are worked out in a moment', () => {
    const big = bigBoard({ cards: 3000, seed: 3 })
    const data: BoardData = JSON.parse(JSON.stringify(big.data))
    const number = data.fields.find((f) => f.type === 'number')!
    const choice = data.fields.find((f) => f.type === 'choice')!
    const rules: BoardRule[] = Array.from({ length: MAX_RULES }, (_, i) => ({
      ...limitOn(ID(i), data.columns[i % data.columns.length].id, 'derived', 5 + i),
      ...(i % 3 === 1 && { measure: { by: 'field' as const, field: number.id } }),
      ...(i % 3 === 2 && { per: 'person' as const, cards: { fields: { [choice.id]: { in: choice.options!.slice(0, 5).map((o) => o.id) } } } }),
      counts: (['leaves', 'topLevel', 'all'] as const)[i % 3],
    }))
    const board = { ...data, rules }
    const idx = indexFor(board)
    const start = performance.now()
    const states = evaluateRules(idx, board)
    const took = performance.now() - start
    expect(states.every((s) => !s.problem)).toBe(true)
    expect(took).toBeLessThan(250)
  })
})
