import type { Gradient } from '@kanbanto/model/colors'
import { CARD, CARDS, GAP, MARK_BOX, TILE_INK, skew } from '@/components/common/logoShapes'

/** A board's tab icon: the mark on a rounded tile in the board's colors (the same tile as the logo on that board). */
export function tabIconSvg(g: Gradient): string {
  const masks = [0, 1].map((i) => {
    const [x, y, h] = CARDS[i + 1]
    const gap = `<rect x="${-GAP.pad}" y="${-GAP.pad}" width="${CARD.width + 2 * GAP.pad}" height="${h + 2 * GAP.pad}" rx="${GAP.rx}" fill="#000" transform="${skew(x, y)}"/>`
    return `<mask id="k${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><rect width="1254" height="1254" fill="#fff"/>${gap}</mask>`
  })
  const cards = CARDS.map(([x, y, h], i) => {
    const card = `<rect width="${CARD.width}" height="${h}" rx="${CARD.rx}" transform="${skew(x, y)}"/>`
    return i < 2 ? `<g mask="url(#k${i})">${card}</g>` : card
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:${g.from}"/><stop offset="1" style="stop-color:${g.to}"/></linearGradient>${masks.join('')}</defs>` +
    `<rect width="64" height="64" rx="14" fill="url(#g)"/>` +
    `<svg x="9" y="9" width="46" height="46" viewBox="${MARK_BOX}" fill="${TILE_INK[g.text]}">${cards.join('')}</svg>` +
    `</svg>`
  )
}

/**
 * Shows a board's tile as the tab's icon, or (null) puts Kanbanto's own back. Every icon the page names is switched,
 * since browsers choose between them themselves. Some browsers (Safari) keep the icon the page loaded with.
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
