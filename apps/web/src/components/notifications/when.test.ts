import { describe, expect, it } from 'vitest'
import { whenOf } from './when'

describe('when a notification came, said briefly', () => {
  it('the time today and yesterday, the day this week and last, the date before', () => {
    // (A Thursday.)
    const now = new Date(2026, 9, 8, 15, 0)
    expect(whenOf(new Date(2026, 9, 8, 10, 42), now)).toBe('10:42')
    expect(whenOf(new Date(2026, 9, 7, 16, 30), now)).toBe('16:30')
    expect(whenOf(new Date(2026, 9, 6, 14, 5), now)).toBe('Tue 14:05')
    expect(whenOf(new Date(2026, 8, 30, 9, 0), now)).toBe('Wed 09:00')
    expect(whenOf(new Date(2026, 8, 12, 9, 0), now)).toBe('12 Sep')
    expect(whenOf(new Date(2025, 11, 24, 9, 0), now)).toBe('24 Dec 2025')
  })
})
