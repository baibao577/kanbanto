import { describe, expect, it } from 'vitest'
import { toDay } from '@kanbanto/model/dates'
import { dueWords } from './cardDates'

describe('how far off a due date is', () => {
  const today = toDay('2026-10-07')
  const noon = new Date(2026, 9, 7, 12, 0).getTime()

  it('counts whole days, where the person is', () => {
    expect(dueWords('2026-10-15', today, noon)).toEqual({ text: '8 days left', late: false })
    expect(dueWords('2026-10-09', today, noon)).toEqual({ text: '2 days left', late: false })
    expect(dueWords('2026-10-08', today, noon)).toEqual({ text: 'due tomorrow', late: false })
    expect(dueWords('2026-10-07', today, noon)).toEqual({ text: 'due today', late: false })
  })

  it('says how late a passed one is', () => {
    expect(dueWords('2026-10-06', today, noon)).toEqual({ text: '1 day late', late: true })
    expect(dueWords('2026-10-04', today, noon)).toEqual({ text: '3 days late', late: true })
  })

  it('a time on the date matters only on the day itself', () => {
    const at = (h: number) => new Date(2026, 9, 7, h, 0).toISOString()
    // Due at 17:00 today, and it's noon: still to come. Due at 09:00: gone by.
    expect(dueWords(at(17), today, noon)).toEqual({ text: 'due today', late: false })
    expect(dueWords(at(9), today, noon)).toEqual({ text: 'was due today', late: true })
    // Tomorrow at 09:00 is tomorrow, however few hours away.
    expect(dueWords(new Date(2026, 9, 8, 9, 0).toISOString(), today, noon)).toEqual({ text: 'due tomorrow', late: false })
  })
})
