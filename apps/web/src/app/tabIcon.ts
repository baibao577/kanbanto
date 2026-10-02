import type { Gradient } from '@kanbanto/model/colors'
import { CARD, CARDS, GAP, MARK_BOX, skew } from '@/components/common/logoShapes'

/** Tab strips are near-white or near-black: the mark stays darker than this on a light one, lighter than this on a dark one. */
const LIGHT_TAB_MAX = 0.75
const DARK_TAB_MIN = 0.55
const OKLCH = /^oklch\(([\d.]+) (.+)\)$/
const lightness = (color: string) => Number(OKLCH.exec(color)?.[1] ?? 0.5)
const shifted = (color: string, by: number) => color.replace(OKLCH, (_, l, rest) => `oklch(${+(Number(l) + by).toFixed(3)} ${rest})`)

/**
 * A board's tab icon: the mark itself, full size, in the board's colors. Both colors are darkened together for light
 * tab strips, or lightened for dark ones, when they'd be hard to see there (a pale yellow on white, say).
 */
export function tabIconSvg(g: Gradient): string {
  const [x0, y0, size] = MARK_BOX.split(' ').map(Number)
  const down = Math.min(0, LIGHT_TAB_MAX - Math.max(lightness(g.from), lightness(g.to)))
  const up = Math.max(0, DARK_TAB_MIN - Math.min(lightness(g.from), lightness(g.to)))
  const gradient = (id: string, by: number) =>
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="${y0}" x2="${x0 + size}" y2="${y0 + size}">` +
    `<stop offset="0" style="stop-color:${shifted(g.from, by)}"/><stop offset="1" style="stop-color:${shifted(g.to, by)}"/></linearGradient>`
  const gaps = [0, 1].map((i) => {
    const [x, y, h] = CARDS[i + 1]
    const gap = `<rect x="${-GAP.pad}" y="${-GAP.pad}" width="${CARD.width + 2 * GAP.pad}" height="${h + 2 * GAP.pad}" rx="${GAP.rx}" fill="#000" transform="${skew(x, y)}"/>`
    return `<mask id="k${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><rect width="1254" height="1254" fill="#fff"/>${gap}</mask>`
  })
  const cards = CARDS.map(([x, y, h], i) => {
    const card = `<rect width="${CARD.width}" height="${h}" rx="${CARD.rx}" fill="#fff" transform="${skew(x, y)}"/>`
    return i < 2 ? `<g mask="url(#k${i})">${card}</g>` : card
  })
  // One gradient across the whole mark (not one per card): a filled square, cut to the mark's shape.
  const fill = (cls: string, id: string) =>
    `<rect class="${cls}" x="${x0}" y="${y0}" width="${size}" height="${size}" fill="url(#${id})" mask="url(#m)"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BOX}">` +
    `<style>.d{display:none}@media (prefers-color-scheme:dark){.l{display:none}.d{display:inline}}</style>` +
    `<defs>${gradient('gl', down)}${gradient('gd', up)}${gaps.join('')}<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254">${cards.join('')}</mask></defs>` +
    fill('l', 'gl') +
    fill('d', 'gd') +
    `</svg>`
  )
}

/**
 * Shows the mark in a board's colors as the tab's icon, or (null) puts Kanbanto's own back. Every icon the page names
 * is switched, since browsers choose between them themselves. Some browsers (Safari) keep the icon the page loaded with.
 */
export function setTabIcon(g: Gradient | null) {
  const href = g && `data:image/svg+xml,${encodeURIComponent(tabIconSvg(g))}`
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    link.dataset.ownHref ??= link.getAttribute('href') ?? ''
    link.dataset.ownType ??= link.type
    link.href = href ?? link.dataset.ownHref
    link.type = href ? 'image/svg+xml' : link.dataset.ownType
  }
}
