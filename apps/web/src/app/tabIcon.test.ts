import { describe, expect, it } from 'vitest'
import { backgroundOf } from '@kanbanto/model/colors'
import { tabIconSvg } from './tabIcon'

describe('a board’s tab icon', () => {
  it('is a tile in the board’s colors', () => {
    const blue = tabIconSvg(backgroundOf('blue')!)
    expect(blue).toContain('stop-color:oklch(0.57 0.2 258)')
    expect(blue).toContain('stop-color:oklch(0.48 0.22 292)')
    expect(tabIconSvg(backgroundOf('custom-210-deep')!)).toContain('stop-color:oklch(0.45 0.13 210)')
  })

  it('draws the mark in the color that reads on that background', () => {
    expect(tabIconSvg(backgroundOf('blue')!)).toContain('fill="#fff"')
    expect(tabIconSvg(backgroundOf('yellow')!)).toContain('fill="#16171c"')
  })
})
