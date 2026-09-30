import { describe, expect, it } from 'vitest'
import { parseWhen } from './when'

// Wednesday 30 Sep 2026, 08:00 local.
const ref = new Date(2026, 8, 30, 8, 0)
const at = (text: string) => {
  const w = parseWhen(text, ref)
  return (
    w && `${w.date.getDate()}/${w.date.getMonth() + 1} ${String(w.date.getHours()).padStart(2, '0')}:${String(w.date.getMinutes()).padStart(2, '0')}`
  )
}

describe('times in plain words', () => {
  it('reads what people type, shortcuts included', () => {
    expect(at('tomorrow 10:00')).toBe('1/10 10:00')
    expect(at('tmr10:00')).toBe('1/10 10:00')
    expect(at('tmrw 9am')).toBe('1/10 09:00')
    expect(at('wednesday1pm')).toBe('30/9 13:00')
    expect(at('next monday 1pm')).toBe('5/10 13:00')
    expect(at('in 2 hours')).toBe('30/9 10:00')
    expect(at('friday')).toBe('2/10 09:00')
    expect(at('hello')).toBe(null)
  })
  it('says which words were the time', () => {
    expect(parseWhen('buy cat on next monday 1pm', ref)).toMatchObject({ text: 'on next monday 1pm', timed: true })
    expect(parseWhen('call mum tmr10:00', ref)).toMatchObject({ text: 'tmr10:00', index: 9 })
  })
})
