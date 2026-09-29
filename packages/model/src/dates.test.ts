// Moments show in each person's own time zone: pin one, so these tests mean the same everywhere.
process.env.TZ = 'Asia/Bangkok'

import { describe, expect, it } from 'vitest'
import { hasTime, isPast, localDayOf, localTimeOf, momentAt, normalizeTaskDate, parseTime, shiftDays, sortTime, toDay } from './dates'

describe('task dates: a whole day, or a moment with a time', () => {
  it('stores days as they are, and times as UTC moments to the minute', () => {
    expect(normalizeTaskDate('2026-10-15')).toBe('2026-10-15')
    expect(normalizeTaskDate('2026-02-30')).toBeNull()
    expect(normalizeTaskDate('2026-10-15T14:30+07:00')).toBe('2026-10-15T07:30:00Z')
    expect(normalizeTaskDate('2026-10-15T07:30:59.123Z')).toBe('2026-10-15T07:30:00Z')
    // Without a time zone, the same text would be a different moment on every computer.
    expect(normalizeTaskDate('2026-10-15T14:30')).toBeNull()
    expect(normalizeTaskDate('next tuesday')).toBeNull()
  })

  it('a moment is the day and time where you are (here, Bangkok: UTC+7)', () => {
    const m = '2026-10-15T20:00:00Z'
    expect(hasTime(m)).toBe(true)
    expect(localDayOf(m)).toBe('2026-10-16')
    expect(localTimeOf(m)).toBe('03:00')
    expect(momentAt('2026-10-16', '03:00')).toBe(m)
    expect(toDay(m)).toBe(toDay('2026-10-16'))
    expect(localTimeOf('2026-10-16')).toBeNull()
  })

  it('reads times the way people type them, on a 24-hour clock', () => {
    expect(['14:30', '1430', '9', '9.15', '09h05', ' 7:00 '].map(parseTime)).toEqual(['14:30', '14:30', '09:00', '09:15', '09:05', '07:00'])
    expect(['24:00', '12:60', '2pm', ''].map(parseTime)).toEqual([null, null, null, null])
  })

  it('moving by days keeps the time; past and sorting use the exact moment', () => {
    expect(shiftDays('2026-10-15', 2)).toBe('2026-10-17')
    expect(shiftDays('2026-10-15T07:30:00Z', -1)).toBe('2026-10-14T07:30:00Z')
    const now = Date.parse('2026-10-15T08:00:00Z')
    expect(isPast('2026-10-15T07:30:00Z', now)).toBe(true)
    expect(isPast('2026-10-15T09:00:00Z', now)).toBe(false)
    // A whole day sorts at its start, before the times on that day.
    expect(sortTime('2026-10-16') < sortTime('2026-10-15T20:00:00Z')).toBe(true)
  })
})
