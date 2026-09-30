import { describe, expect, it } from 'vitest'
import { backgroundOf, customBackground, isBackground, parseCustom } from './colors'
import { CommandSchema } from './schema'

describe('board backgrounds', () => {
  it('colors, designs and custom hues all have a gradient; anything else is the plain canvas', () => {
    expect(backgroundOf('blue')?.text).toBe('light')
    expect(backgroundOf('sand')?.text).toBe('dark')
    expect(customBackground(370, 'deep')).toBe('custom-10-deep')
    expect(backgroundOf('custom-210-light')).toEqual({ from: 'oklch(0.9 0.08 210)', to: 'oklch(0.8 0.11 235)', text: 'dark' })
    expect(parseCustom('custom-350-medium')).toEqual({ hue: 350, shade: 'medium' })
    // The end hue wraps around.
    expect(backgroundOf('custom-350-medium')?.to).toBe('oklch(0.54 0.18 15)')
    for (const bad of ['custom-400-medium', 'custom-10-pale', 'plaid', 'toString', '']) expect(isBackground(bad)).toBe(false)
    expect(backgroundOf(undefined)).toBeNull()
  })

  it('a board takes any of them, and nothing else', () => {
    const cmd = (background: string) => CommandSchema.safeParse({ type: 'board.update', fields: { background } }).success
    expect(cmd('ocean')).toBe(true)
    expect(cmd('custom-120-light')).toBe(true)
    expect(cmd('custom-120-neon')).toBe(false)
    expect(cmd('url(evil)')).toBe(false)
  })
})
