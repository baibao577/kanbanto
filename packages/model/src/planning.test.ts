import { describe, expect, it } from 'vitest'
import { fromDay, isWeekend, mondayOf, monthEndOf, monthStartOf, toDay, weekdayOf } from './dates'
import {
  bookedUntil,
  canSplit,
  emptyPlan,
  endForManDays,
  freeRangeAt,
  manDays,
  nextWorkDay,
  peopleInOrder,
  personFacts,
  planActuals,
  prevWorkDay,
  projectFacts,
  workDays,
  type PlanData,
} from './planning'
import { applyPlanChanges, executePlan, invertPlanChanges, type PlanCommand, type PlanContext } from './planningCommands'
import { PlanCommandSchema } from './planningSchema'

const NOW = '2026-10-03T10:00:00.000Z'
let n = 0
const ctx = (members: string[] = []): PlanContext => ({ now: NOW, newId: () => `id-${++n}`, members: new Set(members) })
const d = toDay
// Monday 5 October 2026.
const MON = d('2026-10-05')

function exec(plan: PlanData, cmd: PlanCommand, members?: string[]) {
  const r = executePlan(plan, cmd, ctx(members))
  if ('error' in r) throw new Error(r.error)
  return { plan: applyPlanChanges(plan, r.changes), changes: r.changes }
}
const refusal = (plan: PlanData, cmd: PlanCommand, members?: string[]) => {
  const r = executePlan(plan, cmd, ctx(members))
  return 'error' in r ? r.error : null
}

/** Two projects, three people (Ann is a workspace member), one role. */
function example() {
  let p = emptyPlan()
  p = exec(p, { type: 'role.add', id: 'se', name: 'SE' }).plan
  p = exec(p, { type: 'project.add', id: 'a', name: 'Data platform', client: 'Client A', plannedMd: 30 }).plan
  p = exec(p, { type: 'project.add', id: 'b', name: 'Mobile app', plannedMd: null }).plan
  p = exec(p, { type: 'person.add', id: 'ann', name: 'Ann', roleId: 'se' }).plan
  p = exec(p, { type: 'person.add', id: 'bob', name: 'Bob', hoursPerDay: 6 }).plan
  p = exec(p, { type: 'person.add', id: 'cat', name: 'Cat' }).plan
  // Ann is a member: give her an account the way the server's rows would have one.
  p = { ...p, people: p.people.map((x) => (x.id === 'ann' ? { ...x, userId: 'user-ann' } : x)) }
  return p
}
const block = (
  id: string,
  projectId: string,
  personId: string | null,
  start: string,
  end: string,
  pct: 25 | 50 | 75 | 100 = 100,
): Extract<PlanCommand, { type: 'block.add' }> => ({
  type: 'block.add',
  id,
  projectId,
  personId,
  start,
  end,
  pct,
})

describe('working days and man-days', () => {
  it('weeks run Monday to Sunday; weekends are Saturday and Sunday', () => {
    expect(weekdayOf(MON)).toBe(1)
    expect(mondayOf(d('2026-10-11'))).toBe(MON)
    expect(mondayOf(MON)).toBe(MON)
    expect([isWeekend(d('2026-10-10')), isWeekend(d('2026-10-11')), isWeekend(MON)]).toEqual([true, true, false])
    expect([monthStartOf(MON), monthEndOf(MON)].map(fromDay)).toEqual(['2026-10-01', '2026-10-31'])
    expect([monthStartOf(d('2027-02-28')), monthEndOf(d('2027-02-01'))].map(fromDay)).toEqual(['2027-02-01', '2027-02-28'])
    expect(fromDay(monthEndOf(d('2026-12-31')))).toBe('2026-12-31')
  })

  it('counts working days, both ends included, and steps over weekends', () => {
    expect(workDays(MON, MON + 4)).toBe(5)
    expect(workDays(MON, MON + 6)).toBe(5)
    expect(workDays(MON, MON + 27)).toBe(20)
    expect(workDays(MON + 5, MON + 6)).toBe(0)
    expect(workDays(MON + 3, MON + 8)).toBe(4)
    expect(workDays(MON + 1, MON)).toBe(0)
    expect(fromDay(nextWorkDay(MON + 5))).toBe('2026-10-12')
    expect(fromDay(prevWorkDay(MON + 6))).toBe('2026-10-09')
    // Another working week (Sunday to Thursday).
    expect(workDays(MON - 1, MON + 5, [0, 1, 2, 3, 4])).toBe(5)
  })

  it('a number of man-days gives the end date: enough working days at that share, rounded up', () => {
    expect(fromDay(endForManDays(MON, 10, 100)!)).toBe('2026-10-16')
    expect(fromDay(endForManDays(MON, 10, 50)!)).toBe('2026-10-30')
    expect(fromDay(endForManDays(MON, 1, 25)!)).toBe('2026-10-08')
    // 3 man-days at 50% is 6 working days; a weekend start begins on Monday.
    expect(fromDay(endForManDays(MON - 2, 3, 50)!)).toBe('2026-10-12')
    expect(fromDay(endForManDays(MON, 2.5, 100)!)).toBe('2026-10-07')
    expect(endForManDays(MON, 0, 100)).toBeNull()
  })

  it('a block is worth its working days × its share, whatever the person’s hours', () => {
    expect(manDays({ start: '2026-10-05', end: '2026-10-30', pct: 50 })).toBe(10)
    expect(manDays({ start: '2026-10-05', end: '2026-10-05', pct: 25 })).toBe(0.25)
  })
})

describe('projects and people', () => {
  it('a project is under, fit (within half a man-day) or over its plan; no plan is no status', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-30', 100)).plan // 20
    expect(projectFacts(p, 'a')).toMatchObject({ scheduled: 20, diff: -10, status: 'under', start: MON, end: d('2026-10-30') })
    p = exec(p, block('2', 'a', null, '2026-10-05', '2026-10-30', 50)).plan // +10, nobody yet
    expect(projectFacts(p, 'a')).toMatchObject({ scheduled: 30, unassigned: 10, status: 'fit' })
    p = exec(p, block('3', 'a', 'bob', '2026-10-05', '2026-10-05', 25)).plan // +0.25
    expect(projectFacts(p, 'a').status).toBe('fit')
    p = exec(p, block('4', 'a', 'cat', '2026-10-05', '2026-10-05', 50)).plan // +0.5
    expect(projectFacts(p, 'a')).toMatchObject({ scheduled: 30.75, status: 'over' })
    expect(projectFacts(p, 'b')).toMatchObject({ scheduled: 0, status: 'none', start: null })
  })

  it('a person’s load adds up across projects; over 100% is found, with when it starts and ends', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-30', 100)).plan
    p = exec(p, block('2', 'b', 'ann', '2026-10-19', '2026-11-13', 50)).plan
    const today = d('2026-10-03') // a Saturday: "now" is the next working day
    expect(personFacts(p, 'ann', today)).toEqual({
      nowLoad: 100,
      peak: 150,
      overFrom: d('2026-10-19'),
      overTo: d('2026-10-30'),
      freeFrom: d('2026-11-16'),
      status: 'over',
      ifFrom: null,
      ifLoad: 0,
      ifProjects: [],
    })
    expect(personFacts(p, 'bob', today)).toMatchObject({ nowLoad: 0, peak: 0, freeFrom: null, status: 'under' })
    // Once the overlap is in the past, it no longer counts.
    expect(personFacts(p, 'ann', d('2026-11-02'))).toMatchObject({ nowLoad: 50, peak: 50, overFrom: null, status: 'under' })
  })

  it('a prospect’s time is kept out of Over / Fit / free from, and said apart: over only if it happens', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-30', 100)).plan
    p = exec(p, block('2', 'b', 'ann', '2026-10-19', '2026-11-13', 50)).plan
    p = exec(p, { type: 'project.update', id: 'b', fields: { prospect: true } }).plan
    const today = d('2026-10-03')
    expect(personFacts(p, 'ann', today)).toEqual({
      nowLoad: 100,
      peak: 100,
      overFrom: null,
      overTo: null,
      freeFrom: d('2026-11-02'),
      status: 'fit',
      ifFrom: d('2026-10-19'),
      ifLoad: 150,
      ifProjects: ['b'],
    })
    // Only on a prospect: nothing booked, nothing over.
    expect(personFacts(p, 'ann', d('2026-11-02'))).toMatchObject({ nowLoad: 0, peak: 0, freeFrom: null, status: 'under', ifFrom: null })
    // It happens: back to counting.
    p = exec(p, { type: 'project.update', id: 'b', fields: { prospect: false } }).plan
    expect(personFacts(p, 'ann', today)).toMatchObject({ peak: 150, status: 'over', ifFrom: null })
    expect(projectFacts(p, 'b').scheduled).toBe(10)
  })

  it('pointing at a free spot gives a week (or five working days), trimmed to the room around it', () => {
    let p = example()
    expect(freeRangeAt(p, 'a', 'ann', MON + 2, 'week')).toEqual({ start: MON, end: MON + 4 })
    expect(freeRangeAt(p, 'a', 'ann', MON + 3, 'days')).toEqual({ start: MON + 3, end: MON + 9 })
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-07')).plan // Mon–Wed
    expect(freeRangeAt(p, 'a', 'ann', MON + 1, 'week')).toBeNull()
    expect(freeRangeAt(p, 'a', 'ann', MON + 3, 'week')).toEqual({ start: MON + 3, end: MON + 4 })
    // Saturday after a block that fills the week: nothing free that week.
    p = exec(p, block('2', 'a', 'ann', '2026-10-12', '2026-10-16')).plan
    expect(freeRangeAt(p, 'a', 'ann', MON + 12, 'week')).toBeNull()
    // Another line is free.
    expect(freeRangeAt(p, 'a', 'bob', MON + 1, 'week')).toEqual({ start: MON, end: MON + 4 })
    // A month: its first to last working day (Thu 1 – Fri 30 Oct), trimmed to the free space around the day.
    expect(freeRangeAt(p, 'a', 'bob', MON + 1, 'month')).toEqual({ start: MON - 4, end: MON + 25 })
    expect(freeRangeAt(p, 'a', 'ann', MON + 3, 'month')).toEqual({ start: MON + 3, end: MON + 4 })
  })

  it('a block splits only inside, with working days on both sides', () => {
    const b = { start: '2026-10-05', end: '2026-10-16' }
    expect(canSplit(b, MON + 7)).toBe(true)
    expect(canSplit(b, MON)).toBe(false)
    expect(canSplit(b, MON + 5)).toBe(true) // Saturday: the first part ends Friday
    expect(canSplit(b, MON + 12)).toBe(false) // nothing left after
  })
})

describe('plan commands', () => {
  it('blocks need a project, a share of 25–100%, a working day, and no overlap on their line', () => {
    let p = example()
    expect(refusal(p, block('x', 'nope', 'ann', '2026-10-05', '2026-10-09'))).toMatch(/project is no longer/)
    expect(refusal(p, { ...block('x', 'a', 'ann', '2026-10-05', '2026-10-09'), pct: 60 as 50 })).toMatch(/25, 50, 75 or 100/)
    expect(refusal(p, block('x', 'a', 'ann', '2026-10-10', '2026-10-11'))).toMatch(/working day/)
    expect(refusal(p, block('x', 'a', 'ann', '2026-10-09', '2026-10-05'))).toMatch(/end on or after/)
    expect(refusal(p, block('x', 'a', 'ann', '2026-10-5', '2026-10-09'))).toMatch(/2026-10-31/)
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-09')).plan
    expect(refusal(p, block('2', 'a', 'ann', '2026-10-09', '2026-10-16'))).toMatch(/overlap another block of Ann on Data platform/)
    expect(refusal(p, block('1', 'a', 'bob', '2026-10-12', '2026-10-16'))).toMatch(/already in use/)
    // Another project, or another person: fine (that's how someone goes over 100%).
    p = exec(p, block('2', 'b', 'ann', '2026-10-05', '2026-10-09')).plan
    p = exec(p, block('3', 'a', 'bob', '2026-10-05', '2026-10-09')).plan
    // Moving onto a line where it would overlap is refused too.
    expect(refusal(p, { type: 'block.update', id: '3', fields: { personId: 'ann' } })).toMatch(/overlap/)
    expect(
      exec(p, { type: 'block.update', id: '3', fields: { personId: 'cat', start: '2026-10-12', end: '2026-10-16', pct: 50 } }).plan.blocks.find(
        (b) => b.id === '3',
      ),
    ).toMatchObject({
      personId: 'cat',
      start: '2026-10-12',
      pct: 50,
      version: 2,
    })
  })

  it('splitting keeps the man-days; the first part ends on the working day before', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-16', 100)).plan
    const r = exec(p, { type: 'block.split', id: '1', at: '2026-10-12', newId: '2' })
    expect(r.plan.blocks.map((b) => [b.id, b.start, b.end])).toEqual([
      ['1', '2026-10-05', '2026-10-09'],
      ['2', '2026-10-12', '2026-10-16'],
    ])
    expect(projectFacts(r.plan, 'a').scheduled).toBe(10)
    expect(refusal(p, { type: 'block.split', id: '1', at: '2026-10-05' })).toMatch(/only be split inside/)
  })

  it('removing a person turns their time into time nobody has yet; members stay', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'bob', '2026-10-05', '2026-10-09')).plan
    p = exec(p, { type: 'line.add', id: 'l1', projectId: 'b', personId: 'bob' }).plan
    const r = exec(p, { type: 'person.remove', id: 'bob' })
    expect(r.plan.blocks[0]).toMatchObject({ id: '1', personId: null })
    expect(r.plan.lines).toEqual([])
    expect(r.plan.people.map((x) => x.id)).toEqual(['ann', 'cat'])
    expect(refusal(p, { type: 'person.remove', id: 'ann' }, ['user-ann'])).toMatch(/stay in its plan/)
    // Ann has left the workspace: she can go.
    expect(refusal(p, { type: 'person.remove', id: 'ann' }, [])).toBeNull()
    // Time nobody has yet already there: theirs goes on a new "not assigned yet" line instead.
    p = exec(p, block('2', 'a', null, '2026-10-07', '2026-10-14')).plan
    expect(exec(p, { type: 'person.remove', id: 'bob' }).plan.projects[0].openLines).toBe(2)
  })

  it('someone added by name can be linked to a member: their time moves over', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'cat', '2026-10-05', '2026-10-09')).plan
    p = exec(p, { type: 'line.add', id: 'l1', projectId: 'b', personId: 'cat' }).plan
    const r = exec(p, { type: 'person.merge', id: 'cat', into: 'ann' })
    expect(r.plan.blocks[0].personId).toBe('ann')
    expect(r.plan.lines.map((l) => [l.projectId, l.personId])).toEqual([['b', 'ann']])
    expect(r.plan.people.map((x) => x.id)).toEqual(['ann', 'bob'])
    expect(refusal(p, { type: 'person.merge', id: 'ann', into: 'cat' })).toMatch(/added by name/)
    expect(refusal(p, { type: 'person.merge', id: 'bob', into: 'cat' })).toMatch(/in the workspace/)
    // Members' names come from their account.
    expect(refusal(p, { type: 'person.update', id: 'ann', fields: { name: 'Annie' } })).toMatch(/account/)
  })

  it('booked until a day counts working days so far; logged time becomes each person’s man-days', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-16', 50)).plan // 10 working days at 50%
    p = exec(p, block('2', 'a', 'bob', '2026-10-19', '2026-10-23')).plan // later
    const blocks = p.blocks.filter((b) => b.projectId === 'a')
    expect(bookedUntil(blocks, d('2026-10-09'))).toBe(2.5) // Mon–Fri of the first week at 50%
    expect(bookedUntil(blocks, d('2026-10-04'))).toBe(0)
    expect(bookedUntil(blocks, d('2026-12-31'))).toBe(10)
    // Ann (6 hours a day) and someone from outside the workspace logged on a's board; b has no board.
    p = exec(p, { type: 'project.update', id: 'a', fields: { boardId: 'board-a' } }).plan
    p = exec(p, { type: 'person.update', id: 'ann', fields: { hoursPerDay: 6 } }).plan
    const actuals = planActuals(p, { 'board-a': { 'user-ann': 720, 'user-guest': 240 }, 'board-z': { 'user-ann': 60 } })
    expect(Object.keys(actuals)).toEqual(['a'])
    expect(actuals.a).toEqual({ people: { ann: { minutes: 720, md: 2 } }, others: { minutes: 240, md: 0.5 }, minutes: 960, md: 2.5 })
  })

  it('people are in role-then-name order until a planner moves one; then the plan keeps their order', () => {
    let p = example()
    const names = (plan: PlanData) => peopleInOrder(plan).map((x) => x.name)
    expect(names(p)).toEqual(['Ann', 'Bob', 'Cat']) // Ann has a role (SE); the others none, by name
    // The first move gives everyone a place.
    const first = exec(p, { type: 'person.move', id: 'cat', beforeId: 'ann' })
    expect(names(first.plan)).toEqual(['Cat', 'Ann', 'Bob'])
    expect(first.changes).toHaveLength(3)
    p = first.plan
    // After that, only the one moved changes.
    const next = exec(p, { type: 'person.move', id: 'cat' })
    expect(names(next.plan)).toEqual(['Ann', 'Bob', 'Cat'])
    expect(next.changes).toHaveLength(1)
    // Someone new comes after the people put in order; undo puts it back.
    const added = exec(next.plan, { type: 'person.add', id: 'dan', name: 'Abe' }).plan
    expect(names(added)).toEqual(['Ann', 'Bob', 'Cat', 'Abe'])
    expect(names(applyPlanChanges(next.plan, invertPlanChanges(next.plan, next.changes, NOW)))).toEqual(['Cat', 'Ann', 'Bob'])
    expect(refusal(p, { type: 'person.move', id: 'cat', beforeId: 'nobody' })).toMatch(/no longer in the plan/)
  })

  it('roles: unique names, removing one leaves people with none; projects: removing takes their time along', () => {
    let p = example()
    expect(refusal(p, { type: 'role.add', name: ' se ' })).toMatch(/already a role/)
    p = exec(p, { type: 'role.add', id: 'ba', name: 'BA' }).plan
    p = exec(p, { type: 'role.move', id: 'ba', beforeId: 'se' }).plan
    expect(p.roles.map((r) => r.name)).toEqual(['BA', 'SE'])
    p = exec(p, { type: 'role.remove', id: 'se' }).plan
    expect(p.people.find((x) => x.id === 'ann')?.roleId).toBeNull()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-09')).plan
    p = exec(p, { type: 'line.add', projectId: 'a', personId: 'bob' }).plan
    const r = exec(p, { type: 'project.remove', id: 'a' })
    expect([r.plan.projects.length, r.plan.blocks.length, r.plan.lines.length]).toEqual([1, 0, 0])
    expect(refusal(p, { type: 'project.update', id: 'a', fields: { plannedMd: -1 } })).toMatch(/0 or more/)
    expect(exec(p, { type: 'project.update', id: 'a', fields: { finished: true } }).plan.projects[0].finishedAt).toBe(NOW)
  })
})

describe('time nobody has yet', () => {
  it('a project can have several "not assigned yet" lines; each keeps its blocks apart', () => {
    let p = example()
    p = exec(p, block('1', 'a', null, '2026-10-05', '2026-10-16')).plan
    expect(refusal(p, block('2', 'a', null, '2026-10-12', '2026-10-23'))).toMatch(/overlap another unassigned block/)
    expect(refusal(p, { ...block('2', 'a', null, '2026-10-12', '2026-10-23'), slot: 1 })).toMatch(/line is no longer there/)
    p = exec(p, { type: 'project.addOpenLine', id: 'a' }).plan
    p = exec(p, { ...block('2', 'a', null, '2026-10-12', '2026-10-23'), slot: 1 }).plan
    expect(projectFacts(p, 'a').unassigned).toBe(20)
    expect(freeRangeAt(p, 'a', null, MON + 7, 'week', 1)).toBeNull()
    expect(freeRangeAt(p, 'a', null, MON + 21, 'week', 1)).toEqual({ start: MON + 21, end: MON + 25 })
    // Someone's time is always on line 0; dropping it on line 1 of "not assigned yet" works.
    p = exec(p, { type: 'block.update', id: '2', fields: { personId: 'ann' } }).plan
    expect(p.blocks.find((b) => b.id === '2')).toMatchObject({ personId: 'ann', slot: 0 })
    p = exec(p, { type: 'block.update', id: '2', fields: { personId: null, slot: 1 } }).plan
    // An empty line can go; the ones after it move up. A line with time on it can't.
    expect(refusal(p, { type: 'project.removeOpenLine', id: 'a', slot: 1 })).toMatch(/has time on it/)
    p = exec(p, { type: 'project.addOpenLine', id: 'a' }).plan
    p = exec(p, { type: 'block.update', id: '2', fields: { slot: 2 } }).plan
    p = exec(p, { type: 'project.removeOpenLine', id: 'a', slot: 1 }).plan
    expect([p.projects[0].openLines, p.blocks.find((b) => b.id === '2')!.slot]).toEqual([2, 1])
    expect(
      refusal(exec(emptyPlan(), { type: 'project.add', id: 'x', name: 'X' }).plan, { type: 'project.removeOpenLine', id: 'x', slot: 0 }),
    ).toMatch(/at least one/)
  })

  it('removing someone puts their time on the first free "not assigned yet" line, or a new one', () => {
    let p = example()
    p = exec(p, block('1', 'a', null, '2026-10-05', '2026-10-16')).plan
    p = exec(p, block('2', 'a', 'bob', '2026-10-12', '2026-10-23')).plan
    const r = exec(p, { type: 'person.remove', id: 'bob' })
    expect(r.plan.projects[0].openLines).toBe(2)
    expect(r.plan.blocks.find((b) => b.id === '2')).toMatchObject({ personId: null, slot: 1 })
  })
})

describe('linking a board', () => {
  it('a project links to one board, and a board to one project', () => {
    let p = exec(example(), { type: 'project.update', id: 'a', fields: { boardId: 'board-1' } }).plan
    expect(p.projects[0].boardId).toBe('board-1')
    expect(refusal(p, { type: 'project.update', id: 'b', fields: { boardId: 'board-1' } })).toMatch(/already linked to Data platform/)
    p = exec(p, { type: 'project.update', id: 'a', fields: { boardId: null } }).plan
    expect(refusal(p, { type: 'project.update', id: 'b', fields: { boardId: 'board-1' } })).toBeNull()
  })
})

describe('undo', () => {
  /** Runs a command, then its undo through plan.restore, and checks the plan is back as it was (apart from versions). */
  function roundTrip(plan: PlanData, cmd: PlanCommand, members?: string[]) {
    const done = exec(plan, cmd, members)
    const undo = invertPlanChanges(done.plan, done.changes, NOW)
    const back = exec(done.plan, { type: 'plan.restore', changes: undo }, members).plan
    // The same records (order within a list aside: people and blocks are sorted where they're shown).
    const plain = (x: PlanData) =>
      JSON.stringify(Object.fromEntries(Object.entries(x).map(([k, list]) => [k, [...list].sort((a, b) => (a.id < b.id ? -1 : 1))])), (k, v) =>
        k === 'version' || k === 'updatedAt' ? undefined : v,
      )
    expect(plain(back)).toBe(plain(plan))
    return { done, back }
  }

  it('every kind of change comes back, cascades included', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'bob', '2026-10-05', '2026-10-16')).plan
    p = exec(p, { type: 'line.add', id: 'l1', projectId: 'b', personId: 'bob' }).plan
    roundTrip(p, block('2', 'b', 'ann', '2026-10-05', '2026-10-09'))
    roundTrip(p, { type: 'block.update', id: '1', fields: { personId: 'cat', projectId: 'b', pct: 50 } })
    roundTrip(p, { type: 'block.split', id: '1', at: '2026-10-12' })
    roundTrip(p, { type: 'project.remove', id: 'a' })
    roundTrip(p, { type: 'person.remove', id: 'bob' })
    roundTrip(p, { type: 'role.remove', id: 'se' })
    roundTrip(p, { type: 'person.merge', id: 'bob', into: 'ann' })
    roundTrip(p, { type: 'project.addOpenLine', id: 'a' })
    roundTrip(p, { type: 'project.update', id: 'a', fields: { boardId: 'board-1' } })
  })

  it('refuses when someone changed it since, or when it would break the plan', () => {
    let p = example()
    p = exec(p, block('1', 'a', 'ann', '2026-10-05', '2026-10-09')).plan
    const moved = exec(p, { type: 'block.update', id: '1', fields: { start: '2026-10-12', end: '2026-10-16' } })
    const undo = invertPlanChanges(moved.plan, moved.changes, NOW)
    // Someone else moves it again first.
    const again = exec(moved.plan, { type: 'block.update', id: '1', fields: { pct: 50 } }).plan
    expect(refusal(again, { type: 'plan.restore', changes: undo })).toMatch(/changed this in the meantime/)
    // Someone else fills the spot it would go back to.
    const filled = exec(moved.plan, block('2', 'a', 'ann', '2026-10-05', '2026-10-09')).plan
    expect(refusal(filled, { type: 'plan.restore', changes: undo })).toMatch(/overlap/)
  })
})

describe('the command schema', () => {
  it('accepts commands the page sends and refuses ones that don’t fit', () => {
    expect(PlanCommandSchema.safeParse(block('1', 'a', null, '2026-10-05', '2026-10-09', 75)).success).toBe(true)
    expect(PlanCommandSchema.safeParse({ ...block('1', 'a', null, '2026-10-05', '2026-10-09'), pct: 30 }).success).toBe(false)
    expect(PlanCommandSchema.safeParse({ ...block('1', 'a', null, '2026-10-05T10:00:00Z', '2026-10-09') }).success).toBe(false)
    expect(PlanCommandSchema.safeParse({ type: 'block.update', id: '1', fields: { title: 'x' } }).success).toBe(false)
    expect(PlanCommandSchema.safeParse({ type: 'nope' }).success).toBe(false)
    const p = exec(example(), block('1', 'a', 'ann', '2026-10-05', '2026-10-09'))
    const undo = invertPlanChanges(p.plan, p.changes, NOW)
    expect(PlanCommandSchema.safeParse({ type: 'plan.restore', changes: undo }).success).toBe(true)
  })
})
