import { describe, expect, it } from 'vitest'
import { backgroundOf } from '@kanbanto/model/colors'
import { tabIconSvg } from './tabIcon'

/** The two colors of the gradient with this id. */
const stops = (svg: string, id: string) =>
  [
    ...svg
      .split(`id="${id}"`)[1]
      .split('</linearGradient>')[0]
      .matchAll(/stop-color:([^"]+)"/g),
  ].map((m) => m[1])

describe('a board’s tab icon', () => {
  it('is the mark in the board’s colors, as they are when they show on any tab', () => {
    const svg = tabIconSvg(backgroundOf('green')!)
    expect(stops(svg, 'gl')).toEqual(['oklch(0.67 0.16 150)', 'oklch(0.55 0.12 190)'])
    expect(stops(svg, 'gd')).toEqual(['oklch(0.67 0.16 150)', 'oklch(0.55 0.12 190)'])
  })

  it('darkens pale colors for light tabs only', () => {
    const svg = tabIconSvg(backgroundOf('yellow')!)
    expect(stops(svg, 'gl')).toEqual(['oklch(0.75 0.15 105)', 'oklch(0.65 0.17 80)'])
    expect(stops(svg, 'gd')).toEqual(['oklch(0.93 0.15 105)', 'oklch(0.83 0.17 80)'])
  })

  it('lightens dark colors for dark tabs only', () => {
    const svg = tabIconSvg(backgroundOf('midnight')!)
    expect(stops(svg, 'gl')).toEqual(['oklch(0.34 0.07 270)', 'oklch(0.2 0.04 285)'])
    expect(stops(svg, 'gd')).toEqual(['oklch(0.69 0.07 270)', 'oklch(0.55 0.04 285)'])
  })
})
