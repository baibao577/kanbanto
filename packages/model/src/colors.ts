import type { Category } from './types'

/** The shared 12-color palette for labels, lists and timeline bars. Values live in index.css as --c-<name>. */
export type ColorName = 'gray' | 'red' | 'orange' | 'amber' | 'yellow' | 'lime' | 'green' | 'teal' | 'sky' | 'blue' | 'violet' | 'pink'

export const COLORS: { id: ColorName; name: string }[] = [
  { id: 'gray', name: 'Gray' },
  { id: 'red', name: 'Red' },
  { id: 'orange', name: 'Orange' },
  { id: 'amber', name: 'Amber' },
  { id: 'yellow', name: 'Yellow' },
  { id: 'lime', name: 'Lime' },
  { id: 'green', name: 'Green' },
  { id: 'teal', name: 'Teal' },
  { id: 'sky', name: 'Sky' },
  { id: 'blue', name: 'Blue' },
  { id: 'violet', name: 'Violet' },
  { id: 'pink', name: 'Pink' },
]

/** CSS color for a palette entry. */
export const tone = (c: ColorName) => `var(--c-${c})`

/** Order new labels get colors in, so neighbours look different. */
export const LABEL_COLOR_CYCLE: ColorName[] = ['blue', 'green', 'orange', 'violet', 'pink', 'teal', 'red', 'amber', 'sky', 'lime', 'yellow', 'gray']

const CATEGORY_TONE: Record<Category, string> = {
  backlog: 'var(--status-backlog)',
  todo: 'var(--status-todo)',
  doing: 'var(--status-doing)',
  done: 'var(--status-done)',
}

/** The color a status shows in: its list's own color if it has one, else its category's. */
export const statusTone = (category: Category, color?: ColorName) => (color ? tone(color) : CATEGORY_TONE[category])

/**
 * Vivid board backgrounds: each palette color as a two-tone gradient (into a neighbouring hue).
 * `text` says what reads well on top of it: light (white) or dark text.
 */
export const BOARD_BACKGROUNDS: Record<ColorName, { from: string; to: string; text: 'light' | 'dark' }> = {
  gray: { from: 'oklch(0.56 0.03 255)', to: 'oklch(0.37 0.035 265)', text: 'light' },
  red: { from: 'oklch(0.62 0.21 25)', to: 'oklch(0.56 0.21 355)', text: 'light' },
  orange: { from: 'oklch(0.73 0.18 58)', to: 'oklch(0.6 0.21 28)', text: 'light' },
  amber: { from: 'oklch(0.84 0.16 88)', to: 'oklch(0.74 0.18 58)', text: 'dark' },
  yellow: { from: 'oklch(0.93 0.15 105)', to: 'oklch(0.83 0.17 80)', text: 'dark' },
  lime: { from: 'oklch(0.88 0.19 128)', to: 'oklch(0.74 0.17 158)', text: 'dark' },
  green: { from: 'oklch(0.67 0.16 150)', to: 'oklch(0.55 0.12 190)', text: 'light' },
  teal: { from: 'oklch(0.7 0.12 188)', to: 'oklch(0.55 0.14 240)', text: 'light' },
  sky: { from: 'oklch(0.73 0.13 222)', to: 'oklch(0.55 0.18 264)', text: 'light' },
  blue: { from: 'oklch(0.57 0.2 258)', to: 'oklch(0.48 0.22 292)', text: 'light' },
  violet: { from: 'oklch(0.54 0.22 295)', to: 'oklch(0.62 0.22 345)', text: 'light' },
  pink: { from: 'oklch(0.71 0.18 352)', to: 'oklch(0.63 0.2 20)', text: 'light' },
}

export interface Gradient {
  from: string
  to: string
  text: 'light' | 'dark'
}

/** Designed board backgrounds beyond the palette colors: two hues each, or dark ones. */
export const BOARD_DESIGNS = {
  sunset: { name: 'Sunset', from: 'oklch(0.8 0.15 70)', to: 'oklch(0.6 0.22 15)', text: 'light' },
  peach: { name: 'Peach', from: 'oklch(0.91 0.07 60)', to: 'oklch(0.8 0.11 20)', text: 'dark' },
  ocean: { name: 'Ocean', from: 'oklch(0.62 0.15 230)', to: 'oklch(0.42 0.14 265)', text: 'light' },
  lagoon: { name: 'Lagoon', from: 'oklch(0.86 0.1 185)', to: 'oklch(0.7 0.12 220)', text: 'dark' },
  aurora: { name: 'Aurora', from: 'oklch(0.7 0.16 165)', to: 'oklch(0.48 0.2 290)', text: 'light' },
  forest: { name: 'Forest', from: 'oklch(0.52 0.1 150)', to: 'oklch(0.36 0.07 185)', text: 'light' },
  mint: { name: 'Mint', from: 'oklch(0.94 0.06 165)', to: 'oklch(0.84 0.09 190)', text: 'dark' },
  berry: { name: 'Berry', from: 'oklch(0.55 0.2 350)', to: 'oklch(0.4 0.17 305)', text: 'light' },
  dusk: { name: 'Dusk', from: 'oklch(0.55 0.15 295)', to: 'oklch(0.7 0.15 40)', text: 'light' },
  midnight: { name: 'Midnight', from: 'oklch(0.34 0.07 270)', to: 'oklch(0.2 0.04 285)', text: 'light' },
  charcoal: { name: 'Charcoal', from: 'oklch(0.42 0.01 260)', to: 'oklch(0.25 0.01 260)', text: 'light' },
  sand: { name: 'Sand', from: 'oklch(0.93 0.05 85)', to: 'oklch(0.83 0.07 65)', text: 'dark' },
} as const satisfies Record<string, Gradient & { name: string }>
export type BoardDesign = keyof typeof BOARD_DESIGNS

/** A custom background: any hue (0–359) in one of three shades, e.g. "custom-210-medium". */
export const SHADES = ['light', 'medium', 'deep'] as const
export type Shade = (typeof SHADES)[number]
export type BoardBackground = ColorName | BoardDesign | `custom-${number}-${Shade}`
const CUSTOM = /^custom-(\d{1,3})-(light|medium|deep)$/
export const customBackground = (hue: number, shade: Shade): BoardBackground => `custom-${Math.round(hue) % 360}-${shade}`
export function parseCustom(v?: string | null): { hue: number; shade: Shade } | null {
  const m = v && CUSTOM.exec(v)
  return m && Number(m[1]) < 360 ? { hue: Number(m[1]), shade: m[2] as Shade } : null
}

/** A gradient from one hue: lightness and chroma by shade, running into a neighbouring hue like the designed ones. */
const SHADE_STEPS: Record<Shade, { from: [number, number]; to: [number, number]; text: Gradient['text'] }> = {
  light: { from: [0.9, 0.08], to: [0.8, 0.11], text: 'dark' },
  medium: { from: [0.68, 0.16], to: [0.54, 0.18], text: 'light' },
  deep: { from: [0.45, 0.13], to: [0.3, 0.1], text: 'light' },
}
const customGradient = ({ hue, shade }: { hue: number; shade: Shade }): Gradient => {
  const s = SHADE_STEPS[shade]
  return { from: `oklch(${s.from[0]} ${s.from[1]} ${hue})`, to: `oklch(${s.to[0]} ${s.to[1]} ${(hue + 25) % 360})`, text: s.text }
}

/** A board background's gradient (null: the plain canvas, or a value this version doesn't know). */
export function backgroundOf(v?: string | null): Gradient | null {
  if (!v) return null
  // (Own keys only: "toString" isn't a background.)
  if (Object.hasOwn(BOARD_BACKGROUNDS, v)) return BOARD_BACKGROUNDS[v as ColorName]
  if (Object.hasOwn(BOARD_DESIGNS, v)) return BOARD_DESIGNS[v as BoardDesign]
  const c = parseCustom(v)
  return c && customGradient(c)
}
export const isBackground = (v: string) => !!backgroundOf(v)

/** The gradient as CSS (a swatch or preview). */
export const gradientCss = (g: Gradient) => `linear-gradient(135deg, ${g.from}, ${g.to})`

/** CSS for a board background gradient. Dark mode dims it a little (see --canvas-dim in index.css). */
export const boardGradient = (g: Gradient) => `linear-gradient(oklch(0 0 0 / var(--canvas-dim)), oklch(0 0 0 / var(--canvas-dim))), ${gradientCss(g)}`
