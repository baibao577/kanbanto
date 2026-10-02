/** The Kanbanto mark's shapes, shared by the logo (Logo.tsx) and a board's tab icon (app/tabIcon.ts). */
export const CARD = { width: 335, rx: 42 }
export const GAP = { pad: 88, rx: 40 }
/** x, y, height: back to front (the back cards are a touch shorter, for a little perspective). */
export const CARDS = [
  [630, 258, 405],
  [455, 333, 425],
  [280, 408, 445],
] as const
export const skew = (x: number, y: number) => `matrix(1 0.4 0 1 ${x} ${y})`
/** The square the mark is drawn in. */
export const MARK_BOX = '250 250 745 745'
/** The mark's color on a tile in a board's colors, by what reads well on that background. */
export const TILE_INK = { light: '#fff', dark: '#16171c' }
