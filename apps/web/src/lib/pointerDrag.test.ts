import { describe, expect, it } from 'vitest'
import { EDGE, edgeSpeed } from './pointerDrag'
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

describe('zoneAt', () => {
  it('splits a row into before, inside and after', () => {
    expect(zoneAt(0.1)).toBe('before')
    expect(zoneAt(0.5)).toBe('inside')
    expect(zoneAt(0.9)).toBe('after')
  })
})
