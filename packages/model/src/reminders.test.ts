import { describe, expect, it } from 'vitest'
import { describeChanges } from './activity'
import { execute } from './commands'
import { indexFor } from './indexer'
import { beforeDueWords, fireTime, upcoming, zoned } from './reminders'
import { exampleData } from './sample'

describe('when reminders fire', () => {
  it('at a moment, or counted back from the due date (a whole day counts from 9:00 in the setter’s zone)', () => {
    expect(fireTime({ id: 'r', at: '2026-10-05T06:00:00Z' }, {})?.toISOString()).toBe('2026-10-05T06:00:00.000Z')
    // A stored time or due date that isn't one (an old file) never fires, instead of being an Invalid Date.
    expect(fireTime({ id: 'r', at: 'soon' }, {})).toBeNull()
    expect(fireTime({ id: 'r', beforeDue: 0 }, { due: 'not-a-date' })).toBeNull()
    expect(fireTime({ id: 'r', beforeDue: 60 }, { due: '2026-10-05T10:00:00Z' })?.toISOString()).toBe('2026-10-05T09:00:00.000Z')
    // 9:00 in Bangkok (UTC+7) is 02:00 UTC; a day before is the 4th.
    expect(fireTime({ id: 'r', beforeDue: 24 * 60, tz: 'Asia/Bangkok' }, { due: '2026-10-05' })?.toISOString()).toBe('2026-10-04T02:00:00.000Z')
    expect(fireTime({ id: 'r', beforeDue: 60 }, {})).toBe(null)
    expect(zoned('2026-01-15', 9, 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })

  it('says how long before the due date in the largest whole unit', () => {
    expect([0, 15, 30, 60, 90, 120, 1440, 2880, 7200].map(beforeDueWords)).toEqual([
      'When it’s due',
      '15 minutes before',
      '30 minutes before',
      '1 hour before',
      '90 minutes before',
      '2 hours before',
      '1 day before',
      '2 days before',
      '5 days before',
    ])
  })

  it('lists what’s still to come, soonest first', () => {
    const task = {
      due: '2026-10-05T10:00:00Z',
      reminders: [
        { id: 'b', beforeDue: 60 },
        { id: 'a', at: '2026-10-01T00:00:00Z' },
        { id: 'old', at: '2020-01-01T00:00:00Z' },
      ],
    }
    expect(upcoming(task, new Date('2026-09-30T00:00:00Z')).map((x) => x.reminder.id)).toEqual(['a', 'b'])
  })
})

describe('setting reminders', () => {
  const data = { ...exampleData('b1', 'ann'), members: [{ id: 'ann', name: 'Ann', createdAt: '', updatedAt: '', version: 1 }] }
  const run = (reminders: object[]) =>
    execute(
      data,
      { type: 'task.update', id: 'A3', fields: { reminders: reminders as never } },
      { now: '2026-09-30T00:00:00Z', newId: () => 'x', idx: indexFor(data) },
    )

  it('keeps them tidy, and refuses a day without a time', () => {
    const r = run([
      { id: 'r1', at: '2026-10-05T14:00:00+07:00', by: 'ann' },
      { id: 'r2', beforeDue: 60, tz: 'Asia/Bangkok', by: 'ghost' },
    ])
    if ('error' in r) throw new Error(r.error)
    expect(r.changes[0].after).toMatchObject({
      reminders: [
        { id: 'r1', at: '2026-10-05T07:00:00Z', by: 'ann' },
        { id: 'r2', beforeDue: 60, tz: 'Asia/Bangkok' },
      ],
    })
    expect(describeChanges(data, r.changes).map((i) => i.text)).toEqual(['set a reminder on “Deploy”'])
    expect(run([{ id: 'r1', at: '2026-10-05' }])).toEqual({ error: 'A reminder needs a time of day.' })
  })
})
