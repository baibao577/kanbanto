import { describe, expect, it } from 'vitest'
import { toDay } from '@kanbanto/model/dates'
import { emptyPlan, type PlanData } from '@kanbanto/model/planning'
import { applyPlanChanges, executePlan, type PlanCommand } from '@kanbanto/model/planningCommands'
import { rowsByPerson, rowsByProject, sheetRange, ticks } from './planLayout'

let n = 0
function build(cmds: PlanCommand[]): PlanData {
  let plan = emptyPlan()
  for (const cmd of cmds) {
    const r = executePlan(plan, cmd, { now: '2026-10-03T00:00:00.000Z', newId: () => `id-${++n}`, members: new Set() })
    if ('error' in r) throw new Error(r.error)
    plan = applyPlanChanges(plan, r.changes)
  }
  return plan
}

const seed: PlanCommand[] = [
  { type: 'role.add', id: 'se', name: 'SE' },
  { type: 'role.add', id: 'ba', name: 'BA' },
  { type: 'project.add', id: 'a', name: 'Data platform', plannedMd: 20 },
  { type: 'project.add', id: 'b', name: 'Mobile app' },
  { type: 'person.add', id: 'nok', name: 'Nok', roleId: 'se' },
  { type: 'person.add', id: 'krit', name: 'Krit', roleId: 'ba' },
  { type: 'person.add', id: 'ann', name: 'Ann', roleId: 'se' },
  { type: 'block.add', id: '1', projectId: 'a', personId: 'nok', start: '2026-10-12', end: '2026-10-16', pct: 100 },
  { type: 'block.add', id: '2', projectId: 'a', personId: 'krit', start: '2026-10-05', end: '2026-10-09', pct: 50 },
  { type: 'block.add', id: '3', projectId: 'b', personId: null, start: '2026-10-05', end: '2026-10-09', pct: 100 },
  { type: 'line.add', id: 'l', projectId: 'a', personId: 'ann' },
]
const plan = build(seed)

describe('the planning sheet', () => {
  it('by project: people with time first (earliest first), then people with none yet, then nobody, then adding', () => {
    const rows = rowsByProject(plan, { canEdit: true, showFinished: false })
    expect(rows.map((r) => r.key)).toEqual([
      'project:a',
      'line:a:krit:person',
      'line:a:nok:person',
      'line:a:ann:person',
      'line:a:-0:person',
      'add-person:a',
      'project:b',
      'line:b:-0:person',
      'add-person:b',
    ])
    expect(rows[0]).toMatchObject({ facts: { scheduled: 7.5, status: 'under' } })
    expect(rows[3]).toMatchObject({ empty: true, md: 0 })
    // Viewers get no "add" rows; finished projects fold away.
    const finished = build([
      { type: 'project.add', id: 'x', name: 'Old' },
      { type: 'project.update', id: 'x', fields: { finished: true } },
    ])
    expect(rowsByProject(finished, { canEdit: false, showFinished: false }).map((r) => r.key)).toEqual(['finished'])
    expect(rowsByProject(finished, { canEdit: false, showFinished: true }).map((r) => r.key)).toEqual(['finished', 'project:x', 'line:x:-0:person'])
  })

  it('a project with several "not assigned yet" lines shows each; a folded group shows only its first row', () => {
    const more = build([
      ...seed,
      { type: 'project.addOpenLine', id: 'b' },
      { type: 'block.add', id: '4', projectId: 'b', personId: null, slot: 1, start: '2026-10-05', end: '2026-10-09', pct: 50 },
    ])
    expect(
      rowsByProject(more, { canEdit: false, showFinished: false })
        .filter((r) => r.key.startsWith('line:b'))
        .map((r) => r.key),
    ).toEqual(['line:b:-0:person', 'line:b:-1:person'])
    expect(
      rowsByProject(more, { canEdit: true, showFinished: false, collapsed: new Set(['project:a']) })
        .map((r) => r.key)
        .slice(0, 2),
    ).toEqual(['project:a', 'project:b'])
    expect(
      rowsByPerson(more, { canEdit: false, today: 0, memberIds: [], roleId: null, collapsed: new Set(['person:ann']) })
        .map((r) => r.key)
        .slice(0, 2),
    ).toEqual(['person:ann', 'person:nok'])
  })

  it('by person: by role then name, their projects, adding; then time nobody has yet', () => {
    const rows = rowsByPerson(plan, { canEdit: true, today: toDay('2026-10-03'), memberIds: [], roleId: null })
    expect(rows.map((r) => r.key)).toEqual([
      'person:ann',
      'line:a:ann:project',
      'add-project:ann',
      'person:nok',
      'line:a:nok:project',
      'add-project:nok',
      'person:krit',
      'line:a:krit:project',
      'add-project:krit',
      'open',
      'line:b:-0:project',
    ])
    expect(rowsByPerson(plan, { canEdit: false, today: 0, memberIds: [], roleId: 'ba' }).map((r) => r.key)).toEqual([
      'person:krit',
      'line:a:krit:project',
      'open',
      'line:b:-0:project',
    ])
  })

  it('the time axis starts two weeks before, on a Monday, and has a mark per month and per week (or day)', () => {
    const today = toDay('2026-10-03')
    const r = sheetRange(plan, today)
    expect(r.start).toBe(toDay('2026-09-14'))
    expect((r.end - r.start + 1) % 7).toBe(0)
    const t = ticks(toDay('2026-09-28'), toDay('2026-10-11'), 'weeks', today)
    expect(t.months.map((m) => m.label)).toEqual(['Sep 2026', 'Oct'])
    // A month the sheet starts in just before the next is left unnamed (the labels would overlap); the year moves on.
    expect(ticks(toDay('2026-09-28'), toDay('2026-10-11'), 'weeks', today, 10).months.map((m) => m.label)).toEqual(['Oct 2026'])
    expect(t.minor.map((m) => [m.label, m.today])).toEqual([
      ['28', true],
      ['5', false],
    ])
    expect(ticks(toDay('2026-10-09'), toDay('2026-10-11'), 'days', today).minor.map((m) => m.weekend)).toEqual([false, true, true])
  })
})
