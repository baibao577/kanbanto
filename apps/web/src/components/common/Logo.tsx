import { useId } from 'react'
import { gradientCss, type Gradient } from '@kanbanto/model/colors'
import { cn } from '@/lib/utils'
import { CARD, CARDS, GAP, MARK_BOX, TILE_INK, skew } from './logoShapes'

/**
 * The Kanbanto mark: three slanted cards, back to front. Each back card is cut where a slightly larger copy of the
 * card in front sits, so the gaps are truly empty and the mark works on any background. Drawn in the text colour
 * (`currentColor`). The same shapes are in public/favicon.svg.
 */
export function LogoMark({ className, title = 'Kanbanto' }: { className?: string; title?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox={MARK_BOX} role="img" aria-label={title} className={cn('size-7 shrink-0', className)} fill="currentColor">
      <defs>
        {[0, 1].map((i) => {
          const [x, y, h] = CARDS[i + 1]
          return (
            <mask key={i} id={`${id}-${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254">
              <rect width="1254" height="1254" fill="#fff" />
              <rect
                x={-GAP.pad}
                y={-GAP.pad}
                width={CARD.width + 2 * GAP.pad}
                height={h + 2 * GAP.pad}
                rx={GAP.rx}
                fill="#000"
                transform={skew(x, y)}
              />
            </mask>
          )
        })}
      </defs>
      {CARDS.map(([x, y, h], i) => {
        const card = <rect width={CARD.width} height={h} rx={CARD.rx} transform={skew(x, y)} />
        return i < 2 ? (
          <g key={i} mask={`url(#${id}-${i})`}>
            {card}
          </g>
        ) : (
          <g key={i}>{card}</g>
        )
      })}
    </svg>
  )
}

/** The mark on a rounded tile in a board's colors: the logo on a board that has a background (its tab icon matches). */
export function LogoTile({ background, className, title }: { background: Gradient; className?: string; title?: string }) {
  return (
    <span
      className={cn('grid size-7 shrink-0 place-items-center rounded-[22%]', className)}
      style={{ background: gradientCss(background), color: TILE_INK[background.text] }}
    >
      <LogoMark className="size-[72%]" title={title} />
    </span>
  )
}
