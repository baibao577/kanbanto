import { describe, expect, it } from 'vitest'
import { applyChanges, invertChanges } from './changes'
import { execute, type Command } from './commands'
import { indexFor } from './indexer'
import { planMove } from './moveBoard'
import type { Change } from './records'
import { makeTask } from './records'
import { isCode, numbersFor, readRef, refOf, suggestCode, taskByRef, withCode, withNumbers } from './refs'
import { exampleData } from './sample'
import { BoardDataSchema, CommandSchema, TaskSchema } from './schema'
import { sortComparator } from './table'
import type { Board, BoardData, Task } from './types'
import { matcher } from './view'

const NOW = '2026-10-08T03:00:00.000Z'

/** The example board as the server holds it: letters, and every card numbered in the order the outline shows them. */
function board(): BoardData {
  const data = exampleData('b1', 'u1')
  const { numbers } = numbersFor(Object.values(data.tasks), indexFor(data).preorder)
  return {
    ...data,
    board: { ...data.board, code: 'WEB' },
    tasks: Object.fromEntries(Object.values(data.tasks).map((t) => [t.id, { ...t, number: numbers.get(t.id) }])),
  }
}
let n = 0
const run = (data: BoardData, command: Command) => {
  const r = execute(data, command, { now: NOW, newId: () => `new${++n}`, idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return r.changes
}
const created = (title: string, id: string): Change => ({
  entity: 'task',
  id,
  before: null,
  after: makeTask({ id, title, status: 'todo', order: 'a5' }, { createdAt: NOW, updatedAt: NOW, version: 1 }),
})
const after = (c: Change) => c.after as Task

describe('a board’s letters', () => {
  it('are 2 to 5 capitals or digits, starting with a letter', () => {
    for (const ok of ['WEB', 'IN', 'B1', 'STEL', 'ABCDE', 'A2B']) expect(isCode(ok), ok).toBe(true)
    for (const no of ['W', 'web', '1AB', 'ABCDEF', 'W-B', 'ไทย', '']) expect(isCode(no), no).toBe(false)
  })

  it('are suggested from the first word of its name, then from other spellings of it', () => {
    expect(suggestCode('Website launch')).toBe('WEB')
    expect(suggestCode('Kanbanto')).toBe('KAN')
    expect(suggestCode('Stel')).toBe('STEL')
    expect(suggestCode('Home and Family')).toBe('HOME')
    expect(suggestCode('Stel OKR', ['STEL'])).toBe('SO')
    expect(suggestCode('Website launch', ['WEB'])).toBe('WL')
    expect(suggestCode('Website launch', ['WEB', 'WL'])).toBe('WEL')
    expect(suggestCode('Café Été')).toBe('CAFE')
    expect(suggestCode('2026 plan')).toBe('PLAN')
    expect(suggestCode('Q4')).toBe('Q4')
    expect(suggestCode('X')).toBe('XX2')
  })

  it('never come out as the Inbox’s, and a name with no Latin letters gets B1, B2…', () => {
    expect(suggestCode('In')).not.toBe('IN')
    expect(isCode(suggestCode('In'))).toBe(true)
    expect(suggestCode('งานบ้าน')).toBe('B1')
    expect(suggestCode('งานบ้าน', ['B1'])).toBe('B2')
    expect(suggestCode('')).toBe('B1')
  })

  it('stay different however many boards want the same ones', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const code = suggestCode('Website launch', taken)
      expect(isCode(code), code).toBe(true)
      expect(taken.has(code), code).toBe(false)
      taken.add(code)
    }
  })

  it('are remembered when they change: the latest first, a few, never the ones it has now', () => {
    const b = { id: 'b', name: 'Web', mode: 'derived', createdAt: NOW, updatedAt: NOW, version: 1 } as Board
    const one = withCode(withCode(b, 'WEB'), 'SITE')
    expect([one.code, one.pastCodes]).toEqual(['SITE', ['WEB']])
    expect(withCode(one, 'SITE')).toBe(one)
    const back = withCode(one, 'WEB')
    expect([back.code, back.pastCodes]).toEqual(['WEB', ['SITE']])
    let many = b
    for (const c of ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG']) many = withCode(many, c)
    expect(many.pastCodes).toEqual(['FF', 'EE', 'DD', 'CC', 'BB'])
  })
})

describe('a card’s name', () => {
  it('is its board’s letters and its number, once it has both', () => {
    expect(refOf({ code: 'WEB' }, { number: 12 })).toBe('WEB-12')
    expect(refOf({ code: 'WEB' }, {})).toBeUndefined()
    expect(refOf({}, { number: 12 })).toBeUndefined()
  })

  it('is read back however it was typed', () => {
    expect(readRef('WEB-12')).toEqual({ code: 'WEB', number: 12 })
    expect(readRef(' web-12 ')).toEqual({ code: 'WEB', number: 12 })
    expect(readRef('#12')).toEqual({ number: 12 })
    expect(readRef('12')).toEqual({ number: 12 })
    for (const no of ['WEB-', 'WEB-0', 'WEB12', 'WEB-12a', 'TOOLONG-1', 'W-1', '-12', 'twelve', '']) expect(readRef(no), no).toBeNull()
  })

  it('finds its card on the board, archived ones too, by the letters the board has or had', () => {
    const data = board()
    const deploy = data.tasks.A3
    const archived = { ...data.tasks.C, archivedAt: NOW, number: 99 }
    const there = { ...data, board: { ...data.board, pastCodes: ['OLD'] }, archived: { C: archived } }
    expect(taskByRef(there, `WEB-${deploy.number}`)).toBe(deploy)
    expect(taskByRef(there, `old-${deploy.number}`)).toBe(deploy)
    expect(taskByRef(there, `#${deploy.number}`)).toBe(deploy)
    expect(taskByRef(there, 'WEB-99')).toBe(archived)
    expect(taskByRef(there, `XYZ-${deploy.number}`)).toBeUndefined()
    expect(taskByRef(there, 'WEB-500')).toBeUndefined()
    expect(taskByRef(there, 'Deploy')).toBeUndefined()
  })
})

describe('numbers, as the server gives them', () => {
  it('no command chooses one: a new card has none until the server answers', () => {
    const data = board()
    const [c] = run(data, { type: 'task.create', id: 'x', parentId: null, fields: { title: 'New' } })
    expect(after(c).number).toBeUndefined()
    const many = run(data, {
      type: 'tasks.import',
      cards: [
        { id: 'i1', parentId: null, fields: { title: 'One' } },
        { id: 'i2', parentId: 'i1', fields: { title: 'Two' } },
      ],
    })
    expect(many.map((x) => after(x).number)).toEqual([undefined, undefined])
    // (And a command can't carry one in: what isn't a field of a card is dropped as it's read.)
    const sent = CommandSchema.parse({ type: 'task.create', id: 'y', parentId: null, fields: { title: 'Sly', number: 1 } })
    expect(after(run(data, sent as Command)[0]).number).toBeUndefined()
  })

  it('new cards take the next ones, in the order they come', () => {
    const data = board()
    const out = withNumbers(data, [created('One', 'n1'), created('Two', 'n2'), created('Three', 'n3')], 14)
    expect(out.changes.map((c) => after(c).number)).toEqual([14, 15, 16])
    expect(out.next).toBe(17)
    // (Nothing else about a record changes: undo goes by its version.)
    expect(after(out.changes[0])).toEqual({ ...after(created('One', 'n1')), number: 14 })
  })

  it('every other command carries a card’s number along untouched', () => {
    const data = board()
    const was = data.tasks.A3.number
    const commands: Command[] = [
      { type: 'task.update', id: 'A3', fields: { title: 'Ship it', status: 'done' } },
      { type: 'task.move', id: 'A3', parentId: 'B', place: { end: true } },
      { type: 'tasks.moveToList', ids: ['A3'], status: 'doing' },
      { type: 'tasks.update', cards: [{ id: 'A3', fields: { priority: 'high' } }] },
      { type: 'task.archive', id: 'A3' },
      { type: 'column.delete', id: 'todo', moveTo: 'doing' },
    ]
    for (const cmd of commands) {
      const changes = run(data, cmd)
      const mine = changes.find((c) => c.entity === 'task' && c.id === 'A3')!
      expect(after(mine).number, cmd.type).toBe(was)
      const again = withNumbers(data, changes, 14)
      expect(again.changes, cmd.type).toBe(changes)
      expect(again.next, cmd.type).toBe(14)
    }
    const archived = applyChanges(data, run(data, { type: 'task.archive', id: 'A3' }))
    expect(after(run(archived, { type: 'task.restore', id: 'A3' })[0]).number).toBe(was)
  })

  it('a card that has a number keeps it, whatever is sent for it', () => {
    const data = board()
    const t = data.tasks.A3
    const { number: _gone, ...bare } = t
    const sent: Change[] = [
      { entity: 'task', id: 'A3', before: t, after: bare as Task },
      { entity: 'task', id: 'A4', before: data.tasks.A4, after: { ...data.tasks.A4, number: 7000 } },
    ]
    const out = withNumbers(data, sent, 14)
    expect(out.changes.map((c) => after(c).number)).toEqual([t.number, data.tasks.A4.number])
    expect(out.next).toBe(14)
  })

  it('a card that comes back keeps the number it had, while nobody else has it and it was once given', () => {
    const data = board()
    const gone = data.tasks.C2
    const without = applyChanges(data, [{ entity: 'task', id: 'C2', before: gone, after: null }])
    expect(after(withNumbers(without, [{ entity: 'task', id: 'C2', before: null, after: gone }], 14).changes[0]).number).toBe(gone.number)
    // Someone else's number, one never given yet, or nonsense: it takes the next instead.
    for (const number of [data.tasks.A.number!, 14, 500, 0, -3, 1.5, 10_000_000_000]) {
      const out = withNumbers(without, [{ entity: 'task', id: 'C2', before: null, after: { ...gone, number } }], 14)
      expect([after(out.changes[0]).number, out.next], String(number)).toEqual([14, 15])
    }
  })

  it('never gives one number twice in one go, and a card named twice gets one', () => {
    const data = board()
    const gone = data.tasks.C2
    const without = applyChanges(data, [{ entity: 'task', id: 'C2', before: gone, after: null }])
    const twins: Change[] = [
      { entity: 'task', id: 'p', before: null, after: { ...gone, id: 'p' } },
      { entity: 'task', id: 'q', before: null, after: { ...gone, id: 'q' } },
    ]
    expect(withNumbers(without, twins, 14).changes.map((c) => after(c).number)).toEqual([gone.number, 14])
    const twice = [created('One', 'n1'), { ...created('One again', 'n1'), before: after(created('One', 'n1')) } as Change]
    const out = withNumbers(data, twice, 14)
    expect(out.changes.map((c) => after(c).number)).toEqual([14, 14])
    expect(out.next).toBe(15)
  })

  it('a card from before there were numbers takes one the first time it changes', () => {
    const data = exampleData('b1', 'u1')
    const changes = run(data, { type: 'task.update', id: 'A3', fields: { title: 'Ship it' } })
    const out = withNumbers(data, changes, 1)
    expect([after(out.changes[0]).number, out.next]).toEqual([1, 2])
  })

  it('undo never changes a card’s number or a board’s letters', () => {
    const data = board()
    const t = data.tasks.A3
    // An undo kept from a copy that never knew the number (made before the server answered, or by an older tab).
    const { number: _gone, ...bare } = t
    const stale: Change[] = [{ entity: 'task', id: 'A3', before: { ...bare, title: 'Deploy now' } as Task, after: t }]
    const undo = run(data, { type: 'records.restore', changes: invertChanges(data, stale, NOW) })
    expect(after(undo[0])).toMatchObject({ title: 'Deploy now', number: t.number })
    // The same for the board: its name goes back, its letters stay.
    const renamed = { ...data.board, name: 'Renamed', version: 2 }
    const now: BoardData = { ...data, board: { ...renamed, code: 'SITE', pastCodes: ['WEB'] } }
    const { code: _code, ...lettersNever } = data.board
    const back = run(now, { type: 'records.restore', changes: [{ entity: 'board', id: 'b1', before: now.board, after: lettersNever as Board }] })
    expect(back[0].after).toMatchObject({ name: data.board.name, code: 'SITE', pastCodes: ['WEB'] })
  })

  it('a card that moves to another board leaves its number behind', () => {
    const source = board()
    const target = { ...exampleData('b2', 'u1'), board: { ...exampleData('b2', 'u1').board, code: 'OPS' } }
    const plan = planMove(source, target, 'A2', {}, { now: NOW, newId: () => `moved${++n}` })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.target.length).toBeGreaterThan(1)
    for (const c of plan.target) expect(after(c).number).toBeUndefined()
    const arrived = withNumbers(target, plan.target, 20)
    expect(arrived.changes.map((c) => after(c).number)).toEqual(plan.target.map((_, i) => 20 + i))
  })

  it('a card can’t be made with the id of an archived one', () => {
    const data = board()
    const archived = applyChanges(data, run(data, { type: 'task.archive', id: 'C' }))
    const r = execute(
      archived,
      { type: 'task.create', id: 'C', parentId: null, fields: { title: 'Again' } },
      { now: NOW, newId: () => 'x', idx: indexFor(archived) },
    )
    expect(r).toEqual({ error: 'A task with that id already exists.' })
  })
})

describe('numbers for a whole board at once', () => {
  it('go in the order the cards were made, and for cards made in one moment in the order the outline shows them', () => {
    const data = exampleData('b1', 'u1')
    const order = indexFor(data).preorder
    const { numbers, next } = numbersFor(Object.values(data.tasks), order)
    expect(order.map((id) => numbers.get(id))).toEqual(order.map((_, i) => i + 1))
    expect(next).toBe(order.length + 1)
    // One made earlier than the rest comes first, wherever it sits.
    const older = Object.values(data.tasks).map((t) => (t.id === 'C1' ? { ...t, createdAt: '2020-01-01T00:00:00.000Z' } : t))
    expect(numbersFor(older, order).numbers.get('C1')).toBe(1)
  })

  it('keep the numbers cards bring (a file’s), when they are theirs alone, and count on from the highest', () => {
    const t = (id: string, number?: number) => makeTask({ id, title: id, status: 'todo', order: 'a1', ...(number !== undefined && { number }) })
    const { numbers, next } = numbersFor([t('a', 7), t('b'), t('c', 7), t('d', 3), t('e', 0)], ['e', 'b', 'c'])
    expect(Object.fromEntries(numbers)).toEqual({ a: 7, d: 3, e: 8, b: 9, c: 10 })
    expect(next).toBe(11)
    expect(numbersFor([t('a')], [], 40).numbers.get('a')).toBe(40)
  })

  it('is quick on a big board', () => {
    const many = Array.from({ length: 5000 }, (_, i) => makeTask({ id: `t${i}`, title: `t${i}`, status: 'todo', order: 'a1' }))
    const data = { tasks: Object.fromEntries(many.slice(0, 3000).map((t, i) => [t.id, { ...t, number: i + 1 }])) }
    const news = many.slice(3000).map((t): Change => ({ entity: 'task', id: t.id, before: null, after: t }))
    const t0 = performance.now()
    const out = withNumbers(data, news, 3001)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(out.next).toBe(5001)
  })
})

describe('finding a card by its name', () => {
  it('the board’s search box takes a number, or the board’s letters and a number', () => {
    const data = board()
    const idx = indexFor({ ...data, board: { ...data.board, pastCodes: ['OLD'] } })
    const found = (q: string) =>
      Object.values(data.tasks)
        .filter(matcher(q, idx.fields.values(), idx.codes)!)
        .map((t) => t.number)
    expect(found('6')).toEqual([6])
    expect(found('#6')).toEqual([6])
    expect(found('web-6')).toEqual([6])
    expect(found('WEB-6')).toEqual([6])
    expect(found('old-6')).toEqual([6])
    // On the way to web-12: everything that starts so.
    expect(found('web-1')).toEqual([1, 10, 11, 12, 13])
    expect(found('web-')).toHaveLength(13)
    // Other letters are just words, found in titles like any others.
    expect(found('xyz-6')).toEqual([])
    expect(found('deploy')).toEqual([data.tasks.A3.number])
  })

  it('the Outline sorts by number, cards without one last', () => {
    const data = board()
    const { number: _n, ...bare } = data.tasks.A1
    const idx = indexFor({ ...data, tasks: { ...data.tasks, A1: bare as Task } })
    const by = sortComparator(idx, { key: 'number', dir: 'desc' }, new Map())
    const order = Object.keys(idx.tasks).sort(by)
    expect(order.slice(0, 2)).toEqual(['C2', 'C1'])
    expect(order.at(-1)).toBe('A1')
  })
})

describe('what is saved and sent', () => {
  it('a card’s number and a board’s letters are part of the record; other values for them are refused', () => {
    const data = board()
    expect(BoardDataSchema.parse(data)).toEqual(data)
    const t = data.tasks.A3
    for (const number of [0, -1, 1.5, 1e10]) expect(TaskSchema.safeParse({ ...t, number }).success, String(number)).toBe(false)
    expect(BoardDataSchema.safeParse({ ...data, board: { ...data.board, code: 'web' } }).success).toBe(false)
  })

  it('the board’s letters can’t be changed by a command', () => {
    const data = board()
    const sent = CommandSchema.parse({ type: 'board.update', fields: { name: 'Renamed', code: 'SLY' } })
    expect(run(data, sent as Command)[0].after).toMatchObject({ name: 'Renamed', code: 'WEB' })
  })
})
