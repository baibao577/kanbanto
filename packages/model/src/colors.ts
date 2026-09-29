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

/** CSS for a board background gradient. Dark mode dims it a little (see --canvas-dim in index.css). */
export const boardGradient = (c: ColorName) => {
  const { from, to } = BOARD_BACKGROUNDS[c]
  return `linear-gradient(oklch(0 0 0 / var(--canvas-dim)), oklch(0 0 0 / var(--canvas-dim))), linear-gradient(135deg, ${from}, ${to})`
}
