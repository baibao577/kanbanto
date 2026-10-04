import { describe, expect, it } from 'vitest'
import { calendarItems } from './calendar'
import { foldLine, toIcs } from './ics'
import { makeTask } from './records'
import { builtIn, EXAMPLE_COLUMNS, type BoardData, type Member, type Task } from './types'

const person = (id: string): Member => ({ id, name: id, ...builtIn() })
const task = (id: string, extra: Partial<Task> = {}) => makeTask({ id, title: `Task ${id}`, status: 'todo', order: 'a1', ...extra })
const board = (members: string[], tasks: Task[], mode: 'manual' | 'derived' = 'manual'): BoardData => ({
  board: { id: 'b', name: 'Board', mode, ...builtIn() },
  members: members.map(person),
  columns: EXAMPLE_COLUMNS,
  labels: [],
  tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
})
const keys = (data: BoardData, who: string, opts?: { maxAlerts?: number }) => calendarItems(data, who, opts).map((i) => `${i.taskId}:${i.key}`)

describe('whose cards are in a calendar', () => {
  it('cards assigned to you, and nobody’s cards on a board only you are on', () => {
    const tasks = [
      task('mine', { assigneeId: 'ann', due: '2026-10-15' }),
      task('theirs', { assigneeId: 'bob', due: '2026-10-15' }),
      task('nobodys', { due: '2026-10-15' }),
      task('undated', { assigneeId: 'ann' }),
    ]
    expect(keys(board(['ann', 'bob'], tasks), 'ann')).toEqual(['mine:due'])
    expect(keys(board(['ann'], tasks), 'ann')).toEqual(['mine:due', 'nobodys:due'])
    // Someone who isn't on the board at all isn't "the only person" on it.
    expect(keys(board(['ann'], tasks), 'bob')).toEqual(['theirs:due'])
  })

  it('a whole day is an all-day event; a moment is half an hour from then', () => {
    const data = board(['ann'], [task('day', { due: '2026-10-15' }), task('time', { due: '2026-10-15T07:30:00Z' })])
    expect(calendarItems(data, 'ann').map((i) => i.when)).toEqual([
      { day: '2026-10-15' },
      { start: '2026-10-15T07:30:00Z', end: '2026-10-15T08:00:00Z' },
    ])
  })

  it('done cards stay, ticked, without alerts or reminders (also a parent that follows its subtasks)', () => {
    const reminders = [{ id: 'r', beforeDue: 60, by: 'ann' }]
    const data = board(
      ['ann'],
      [
        task('p', { due: '2026-10-15T07:30:00Z', reminders }),
        task('c', { parentId: 'p', status: 'done', due: '2026-10-14', reminders: [{ id: 'r2', at: '2026-10-13T01:00:00Z', by: 'ann' }] }),
      ],
      'derived',
    )
    expect(calendarItems(data, 'ann')).toMatchObject([
      { key: 'due', taskId: 'p', title: '✓ Task p', alerts: [] },
      { key: 'due', taskId: 'c', title: '✓ Task c', alerts: [] },
    ])
  })
})

describe('reminders in a calendar', () => {
  const timed = '2026-10-15T07:30:00Z'

  it('are alerts on the due event when it has a time and they come before it', () => {
    const data = board(
      ['ann'],
      [
        task('t', {
          due: timed,
          reminders: [
            { id: 'a', beforeDue: 60, by: 'ann' },
            { id: 'b', at: '2026-10-15T07:00:00Z', by: 'ann' },
            { id: 'same', beforeDue: 30, by: 'ann' },
            { id: 'after', at: '2026-10-15T09:00:00Z', by: 'ann' },
            { id: 'early', at: '2026-08-01T09:00:00Z', by: 'ann' },
          ],
        }),
      ],
    )
    const items = calendarItems(data, 'ann')
    expect(items[0]).toMatchObject({ key: 'due', alerts: [60, 30] })
    expect(items.slice(1)).toEqual([
      { key: 'r:after', taskId: 't', title: '⏰ Task t', when: { start: '2026-10-15T09:00:00Z', end: '2026-10-15T09:15:00Z' }, alerts: [0] },
      { key: 'r:early', taskId: 't', title: '⏰ Task t', when: { start: '2026-08-01T09:00:00Z', end: '2026-08-01T09:15:00Z' }, alerts: [0] },
    ])
  })

  it('are events of their own on a whole-day due date (9:00 where they were set), and past the fifth alert', () => {
    const day = board(['ann'], [task('t', { due: '2026-10-15', reminders: [{ id: 'r', beforeDue: 0, tz: 'Asia/Bangkok', by: 'ann' }] })])
    expect(calendarItems(day, 'ann')[1]).toMatchObject({ key: 'r:r', when: { start: '2026-10-15T02:00:00Z', end: '2026-10-15T02:15:00Z' } })

    const many = board(
      ['ann'],
      [task('t', { due: timed, reminders: [10, 20, 30, 40, 50, 60].map((m) => ({ id: `r${m}`, beforeDue: m, by: 'ann' })) })],
    )
    expect(calendarItems(many, 'ann')[0].alerts).toEqual([10, 20, 30, 40, 50])
    expect(keys(many, 'ann')).toEqual(['t:due', 't:r:r60'])
    // A calendar link: every reminder is an event.
    expect(keys(many, 'ann', { maxAlerts: 0 })).toHaveLength(7)
  })

  it('go to the assignee, or whoever set them when nobody is assigned', () => {
    const reminders = [
      { id: 'ann', at: '2026-10-14T01:00:00Z', by: 'ann' },
      { id: 'bob', at: '2026-10-14T02:00:00Z', by: 'bob' },
      { id: 'none', at: '2026-10-14T03:00:00Z' },
    ]
    const data = board(['ann', 'bob'], [task('free', { due: timed, reminders }), task('bobs', { assigneeId: 'bob', due: timed, reminders })])
    // Ann's reminder on a card that isn't hers: an event of its own, since the due date isn't in her calendar.
    expect(keys(data, 'ann')).toEqual(['free:r:ann'])
    expect(calendarItems(data, 'bob').map((i) => [i.taskId, i.key, i.alerts])).toEqual([
      ['free', 'r:bob', [0]],
      ['bobs', 'due', [1830, 1770, 1710]],
    ])
  })

  it('wait for a due date when they count back from one', () => {
    expect(keys(board(['ann'], [task('t', { reminders: [{ id: 'r', beforeDue: 60, by: 'ann' }] })]), 'ann')).toEqual([])
  })
})

describe('the calendar file', () => {
  const ics = toIcs({
    name: 'Kanbanto',
    events: [
      {
        uid: 'b-t-due@kanbanto',
        title: 'Pay rent; call Bob, then\nrest',
        when: { day: '2026-12-31' },
        alerts: [],
        changedAt: '2026-10-01T10:20:30.000Z',
      },
      {
        uid: 'b-u-due@kanbanto',
        title: 'Review',
        description: 'Board\nhttps://example.com/#/b/b?task=u',
        url: 'https://example.com/#/b/b?task=u',
        when: { start: '2026-10-15T07:30:00Z', end: '2026-10-15T08:00:00Z' },
        alerts: [60, 0],
        changedAt: 'not a date',
      },
    ],
  })

  it('has all-day events ending the day after, moments in UTC, and alerts', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('DTSTAMP:20261001T102030Z\r\nDTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\n')
    expect(ics).toContain('DTSTART:20261015T073000Z\r\nDTEND:20261015T080000Z\r\n')
    expect(ics).toContain('TRIGGER:-PT60M')
    expect(ics).toContain('TRIGGER:PT0M')
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
    expect(ics.split('\r\n').every((line) => !line.includes('\n'))).toBe(true)
  })

  it('escapes text', () => {
    expect(ics).toContain('SUMMARY:Pay rent\\; call Bob\\, then\\nrest')
    expect(ics).toContain('DESCRIPTION:Board\\nhttps://example.com/#/b/b?task=u')
  })

  it('folds long lines at 75 bytes without cutting a character', () => {
    const line = `SUMMARY:${'ทดสอบปฏิทิน'.repeat(12)} 🎉 end`
    const folded = foldLine(line).split('\r\n')
    expect(folded.length).toBeGreaterThan(1)
    for (const piece of folded) expect(new TextEncoder().encode(piece).length).toBeLessThanOrEqual(75)
    expect(folded.slice(1).every((p) => p.startsWith(' '))).toBe(true)
    expect(folded.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line)
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short')
  })
})
