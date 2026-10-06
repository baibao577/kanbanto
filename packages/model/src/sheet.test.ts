import { describe, expect, it } from 'vitest'
import { parseSheet, SHEET_MAX_COLUMNS, SHEET_MAX_ROWS } from './sheet'
import { dateOrderOf, isAmbiguousDate, readDate, readNumber, readPriority, readYes } from './sheetValues'

describe('reading rows', () => {
  it('pasted cells are tab-separated; a .csv has commas, or semicolons', () => {
    expect(parseSheet('Name\tEmail\nAnn\tann@example.com\n')).toEqual({
      rows: [
        ['Name', 'Email'],
        ['Ann', 'ann@example.com'],
      ],
      delimiter: '\t',
    })
    expect(parseSheet('a,b;c\n1,2').rows).toEqual([
      ['a', 'b;c'],
      ['1', '2'],
    ])
    expect(parseSheet('a;b;c\n1,5;2;3')).toEqual({
      rows: [
        ['a', 'b', 'c'],
        ['1,5', '2', '3'],
      ],
      delimiter: ';',
    })
    // A tab wins even when a cell has commas in it.
    expect(parseSheet('Title\tNotes\nA, B and C\tx').rows[1]).toEqual(['A, B and C', 'x'])
  })

  it('quotes hold separators, line breaks and doubled quotes', () => {
    const { rows } = parseSheet('Title,Notes\r\n"Plan, v2","line one\nline two"\r\n"She said ""hi""",  spaced  \r\n')
    expect(rows).toEqual([
      ['Title', 'Notes'],
      ['Plan, v2', 'line one\nline two'],
      ['She said "hi"', 'spaced'],
    ])
    // A quote in the middle of a cell is just a quote.
    expect(parseSheet('a\n5" nails').rows[1]).toEqual(['5" nails'])
  })

  it('rows are made the same width; empty rows in the middle stay, so row numbers match the sheet', () => {
    const { rows } = parseSheet('\uFEFFa,b,c\n1\n\n4,5,6,,\n\n\n')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['', '', ''],
      ['4', '5', '6'],
    ])
  })

  it('says so when there is nothing, or too much', () => {
    expect(() => parseSheet(' \n\n')).toThrow(/nothing to import/)
    expect(() => parseSheet(Array.from({ length: SHEET_MAX_ROWS + 1 }, (_, i) => `row ${i}`).join('\n'))).toThrow(/too many rows/)
    expect(parseSheet(Array.from({ length: SHEET_MAX_ROWS }, (_, i) => `row ${i}`).join('\n')).rows).toHaveLength(SHEET_MAX_ROWS)
    expect(() => parseSheet(Array.from({ length: SHEET_MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join('\t'))).toThrow(/too many columns/)
  })
})

describe('reading dates', () => {
  const day = (text: string, order?: 'dmy' | 'mdy') => {
    const r = readDate(text, order, 2026)
    return r ? (r.time ? `${r.day} ${r.time}` : r.day) : null
  }

  it('reads the forms people have', () => {
    const cases: [string, string | null][] = [
      ['2026-10-15', '2026-10-15'],
      ['2026/1/5', '2026-01-05'],
      ['2026-10-15 14:30', '2026-10-15 14:30'],
      ['2026-10-15T07:30:00Z', '2026-10-15 07:30'],
      ['31/10/2026', '2026-10-31'],
      ['10/31/2026', '2026-10-31'],
      ['31.10.2026', '2026-10-31'],
      ['31-10-26', '2026-10-31'],
      ['5/5/2026', '2026-05-05'],
      ['15 Oct 2026', '2026-10-15'],
      ['15-Oct-26', '2026-10-15'],
      ['15 October, 2026', '2026-10-15'],
      ['Oct 15, 2026', '2026-10-15'],
      ['October 15 2026', '2026-10-15'],
      ['Sept. 3rd, 2026', '2026-09-03'],
      ['15 Oct', '2026-10-15'],
      ['Oct 15', '2026-10-15'],
      ['15/10/2026 2:30 PM', '2026-10-15 14:30'],
      ['15 Oct 2026, 09:05', '2026-10-15 09:05'],
      ['12/31/2026 12:00 am', '2026-12-31 00:00'],
      // Thai months, Buddhist-era years, Thai digits.
      ['15 ตุลาคม 2569', '2026-10-15'],
      ['15 ต.ค. 2569', '2026-10-15'],
      ['15 ต.ค. 69', '2026-10-15'],
      ['15/10/2569', '2026-10-15'],
      ['๑๕/๑๐/๒๕๖๙', '2026-10-15'],
      ['15 ต.ค. 2569 14.30 น.', '2026-10-15 14:30'],
      ['1 พ.ค. 2569', '2026-05-01'],
      // Not dates.
      ['soon', null],
      ['', null],
      ['31/02/2026', null],
      ['2026-13-01', null],
      ['15 Octember 2026', null],
      ['15/10', null],
      ['2026-10-15 25:00', null],
    ]
    for (const [text, want] of cases) expect([text, day(text)]).toEqual([text, want])
  })

  it('a date that could be either way round isn’t read until it’s said which', () => {
    expect(day('3/4/2026')).toBeNull()
    expect(day('3/4/2026', 'dmy')).toBe('2026-04-03')
    expect(day('3/4/2026', 'mdy')).toBe('2026-03-04')
    // One that only works one way is read that way, whatever was said.
    expect(day('31/10/2026', 'mdy')).toBe('2026-10-31')
    expect(isAmbiguousDate('3/4/2026')).toBe(true)
    expect(isAmbiguousDate('3/4/2026 10:00')).toBe(true)
    expect(isAmbiguousDate('5/5/2026')).toBe(false)
    expect(isAmbiguousDate('31/10/2026')).toBe(false)
    expect(isAmbiguousDate('15 Oct 2026')).toBe(false)
  })

  it('a column settles it from all its values', () => {
    expect(dateOrderOf(['1/2/2026', '3/4/2026', '25/12/2026'])).toBe('dmy')
    expect(dateOrderOf(['1/2/2026', '12/25/2026 09:00'])).toBe('mdy')
    expect(dateOrderOf(['1/2/2026', '3/4/2026', '', 'soon', '2026-10-15'])).toBe('either')
    expect(dateOrderOf(['25/12/2026', '12/25/2026'])).toBe('mixed')
    expect(dateOrderOf([])).toBe('either')
  })
})

describe('reading numbers, yes and no, priorities', () => {
  it('numbers with separators, signs and units', () => {
    const cases: [string, number | null][] = [
      ['1200', 1200],
      ['1,200', 1200],
      ['1,200.50', 1200.5],
      ['1.200,50', 1200.5],
      ['1.200.000', 1200000],
      ['1 200 000', 1200000],
      ['12,5', 12.5],
      ['0,125', 0.125],
      ['1.5', 1.5],
      ['1.200', 1.2],
      ['.5', 0.5],
      ['-40', -40],
      ['(500)', -500],
      ['฿1,200', 1200],
      ['$ 40.00', 40],
      ['40 USD', 40],
      ['12%', 12],
      ['๑,๒๐๐', 1200],
      ['+7', 7],
      ['', null],
      ['abc', null],
      ['1,2,3', null],
      ['1.2.3', null],
      ['12 apples and 3', null],
    ]
    for (const [text, want] of cases) expect([text, readNumber(text)]).toEqual([text, want])
  })

  it('a ticked box', () => {
    for (const yes of ['yes', 'Y', 'TRUE', '1', 'x', '✓', 'ใช่']) expect([yes, readYes(yes)]).toEqual([yes, true])
    for (const no of ['no', 'N', 'false', '0', '', 'ไม่']) expect([no, readYes(no)]).toEqual([no, false])
    expect(readYes('maybe')).toBeNull()
  })

  it('a priority', () => {
    expect(['Urgent', 'HIGH', 'medium', 'low', 'P1', 'Normal', 'ด่วน', 'สูง'].map(readPriority)).toEqual([
      'urgent',
      'high',
      'medium',
      'low',
      'high',
      'medium',
      'urgent',
      'high',
    ])
    expect(readPriority('soonish')).toBeNull()
    expect(readPriority('')).toBeNull()
  })
})
