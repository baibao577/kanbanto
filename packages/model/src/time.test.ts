import { describe, expect, it } from 'vitest'
import { formatDuration, formatHours, parseDuration, parseLog, toManDays } from './time'

const ok = (text: string) => {
  const r = parseLog(text)
  if (!r.ok) throw new Error(`${text}: ${r.error}`)
  return [r.minutes, r.note]
}
const error = (text: string) => {
  const r = parseLog(text)
  return r.ok ? null : r.error
}

describe('reading what people type in the log box', () => {
  it('takes the time from either end, and the rest as the note', () => {
    expect(ok('3h 20m')).toEqual([200, ''])
    expect(ok('3h20m')).toEqual([200, ''])
    expect(ok('3h20')).toEqual([200, ''])
    expect(ok('API integration – 3h 20m')).toEqual([200, 'API integration'])
    expect(ok('1:30 review')).toEqual([90, 'review'])
    expect(ok('review: 45m')).toEqual([45, 'review'])
    expect(ok('90m')).toEqual([90, ''])
    expect(ok('45 min call')).toEqual([45, 'call'])
    expect(ok('2 hours')).toEqual([120, ''])
    expect(ok('fix bug 42 1h')).toEqual([60, 'fix bug 42'])
  })

  it('a plain number is hours, with a dot or a comma; past 12 it asks', () => {
    expect(ok('1.5')).toEqual([90, ''])
    expect(ok('1,5')).toEqual([90, ''])
    expect(ok('2 review')).toEqual([120, 'review'])
    expect(ok('0.25')).toEqual([15, ''])
    expect(error('20')).toBe('20 hours? Type 20m for minutes.')
    expect(error('api 20')).toBe('20 hours? Type 20m for minutes.')
    expect(ok('20h')).toEqual([1200, ''])
  })

  it('refuses no time, nothing, and more than a day; warns past 8h', () => {
    expect(error('')).toMatch(/Type a time/)
    expect(error('review')).toMatch(/Add a time/)
    expect(error('0m')).toMatch(/no time/)
    expect(error('25h')).toMatch(/up to 24h/)
    const long = parseLog('9h')
    expect(long.ok && long.warning).toMatch(/9h in one go/)
    const fine = parseLog('8h')
    expect(fine.ok && fine.warning).toBeNull()
  })

  it('a cell of My week takes only a time', () => {
    expect(parseDuration('2')).toBe(120)
    expect(parseDuration('1:30')).toBe(90)
    expect(parseDuration('45m')).toBe(45)
    expect(parseDuration('45')).toEqual({ error: '45 hours? Type 45m for minutes.' })
    expect(parseDuration('2 review')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })
})

describe('showing time', () => {
  it('as hours and minutes, short hours, and man-days of the person’s working day', () => {
    expect([formatDuration(45), formatDuration(60), formatDuration(200), formatDuration(1440)]).toEqual(['45m', '1h', '3h 20m', '24h'])
    expect([formatHours(90), formatHours(20), formatHours(480)]).toEqual(['1.5', '0.3', '8'])
    expect(toManDays(480)).toBe(1)
    expect(toManDays(360, 6)).toBe(1)
    expect(toManDays(240, 8)).toBe(0.5)
  })
})
