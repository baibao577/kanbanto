import { describe, expect, it } from 'vitest'
import { parseWhen, titleDate } from './when'

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

// The same words on a server, for someone somewhere else: read on their clock, whatever the server's own is.
describe('times in plain words, in a time zone', () => {
  // Wednesday 30 Sep 2026, 20:00 UTC: already Thursday 1 Oct, 03:00, in Bangkok.
  const now = new Date('2026-09-30T20:00:00Z')
  const read = (text: string, zone: string) => {
    const w = parseWhen(text, now, zone)
    return w && `${w.day} ${w.date.toISOString().slice(0, 16)}Z${w.timed ? '' : ' (day)'}`
  }

  it('"tomorrow" is the day after today where the person is', () => {
    expect(read('tomorrow 3pm', 'Asia/Bangkok')).toBe('2026-10-02 2026-10-02T08:00Z')
    expect(read('tomorrow 3pm', 'America/New_York')).toBe('2026-10-01 2026-10-01T19:00Z')
    expect(read('tomorrow 3pm', 'UTC')).toBe('2026-10-01 2026-10-01T15:00Z')
  })

  it('a day with no time is that whole day there (9:00 for the moment)', () => {
    expect(read('friday', 'Asia/Bangkok')).toBe('2026-10-02 2026-10-02T02:00Z (day)')
    expect(read('today', 'Asia/Bangkok')).toBe('2026-10-01 2026-10-01T02:00Z (day)')
  })

  it('a clock change between now and then doesn’t move the time', () => {
    // Berlin goes back an hour on 25 Oct 2026: 3pm on the 26th is 14:00 UTC, not 13:00.
    expect(read('26 october 3pm', 'Europe/Berlin')).toBe('2026-10-26 2026-10-26T14:00Z')
    expect(read('20 october 3pm', 'Europe/Berlin')).toBe('2026-10-20 2026-10-20T13:00Z')
  })

  it('a title’s time: the words come out, and the due date is the moment, or the whole day', () => {
    expect(titleDate('Call Sam about the invoice tomorrow 3pm', now, 'Asia/Bangkok')).toMatchObject({
      title: 'Call Sam about the invoice',
      due: '2026-10-02T08:00:00Z',
    })
    expect(titleDate('Pay rent by friday', now, 'Asia/Bangkok')).toMatchObject({ title: 'Pay rent', due: '2026-10-02' })
    expect(titleDate('Renew the domain', now, 'Asia/Bangkok')).toBeNull()
    // (Nothing but a time is a title, not a date.)
    expect(titleDate('tomorrow', now, 'Asia/Bangkok')).toBeNull()
  })
})
