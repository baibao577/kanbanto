import { describe, expect, it } from 'vitest'
import { EDGE, edgeSpeed, pageInset, pageSide, pageStep } from './pointerDrag'
import { zoneAt } from '@/components/tree/useRowDrag'

describe('edgeSpeed', () => {
  it('is zero away from the edges', () => {
    expect(edgeSpeed(500, 0, 1000)).toBe(0)
    expect(edgeSpeed(EDGE, 0, 1000)).toBe(0)
  })
  it('scrolls back near the start and forward near the end, faster closer in', () => {
    expect(edgeSpeed(EDGE - 10, 0, 1000)).toBeLessThan(0)
    expect(edgeSpeed(1000 - EDGE + 10, 0, 1000)).toBeGreaterThan(0)
    expect(Math.abs(edgeSpeed(2, 0, 1000))).toBeGreaterThan(Math.abs(edgeSpeed(EDGE - 10, 0, 1000)))
    expect(edgeSpeed(-50, 0, 1000)).toBe(edgeSpeed(0, 0, 1000)) // beyond the edge: top speed, no more
  })
  it('uses a smaller edge on small areas, so their middle never scrolls', () => {
    expect(edgeSpeed(45, 0, 90)).toBe(0)
    expect(edgeSpeed(5, 0, 90)).toBeLessThan(0)
    expect(edgeSpeed(5, 0, 0)).toBe(0)
  })
})

describe('paging a board under a finger', () => {
  // A phone 360 wide; lists 272 wide, 12 apart, after 16 of padding.
  const area = { left: 0, right: 360 }
  const lists = (scrolled: number) => [0, 1, 2].map((i) => ({ left: 16 + i * 284 - scrolled, right: 288 + i * 284 - scrolled }))

  it('leaves a list in the middle of a phone, and little room on a wide screen', () => {
    expect(pageInset(360, 272)).toBe(44)
    expect(pageInset(1200, 272)).toBe(72)
    expect(pageInset(280, 272)).toBe(8)
  })
  it('turns when the finger is on the list a side cuts off, or right at a side', () => {
    // At the start: the first list in full, 60 of the second showing from 300.
    expect(pageSide(180, area, lists(0))).toBe(0)
    expect(pageSide(290, area, lists(0))).toBe(0)
    expect(pageSide(305, area, lists(0))).toBe(1)
    expect(pageSide(20, area, lists(0))).toBe(-1)
    // The second list in the middle (44..316), a sliver of its neighbors on each side.
    expect(pageSide(60, area, lists(256))).toBe(0)
    expect(pageSide(300, area, lists(256))).toBe(0)
    expect(pageSide(330, area, lists(256))).toBe(1)
    expect(pageSide(30, area, lists(256))).toBe(-1)
  })
  it('brings the next list to the middle, one at a time, and back', () => {
    const first = pageStep(area, lists(0), 1, 44)
    expect(first).toBe(256) // the second list: 300..572 → 44..316
    expect(pageStep(area, lists(first), 1, 44)).toBe(284) // then the third
    expect(pageStep(area, lists(first + 284), 1, 44)).toBe(0) // nothing after it
    expect(pageStep(area, lists(first + 284), -1, 44)).toBe(-284)
    expect(pageStep(area, lists(0), -1, 44)).toBe(0)
  })
})

describe('zoneAt', () => {
  it('splits a row into before, inside and after', () => {
    expect(zoneAt(0.1)).toBe('before')
    expect(zoneAt(0.5)).toBe('inside')
    expect(zoneAt(0.9)).toBe('after')
  })
})
