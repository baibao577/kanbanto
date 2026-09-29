import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * The Kanbanto mark: three slanted cards, back to front. Each back card is cut where a slightly larger copy of the
 * card in front sits, so the gaps are truly empty and the mark works on any background. Drawn in the text colour
 * (`currentColor`). The same shapes are in public/favicon.svg.
 */
const CARD = { width: 335, rx: 42 }
const GAP = { pad: 88, rx: 40 }
/** x, y, height: back to front (the back cards are a touch shorter, for a little perspective). */
const CARDS = [
  [630, 258, 405],
  [455, 333, 425],
  [280, 408, 445],
] as const
const skew = (x: number, y: number) => `matrix(1 0.4 0 1 ${x} ${y})`

export function LogoMark({ className, title = 'Kanbanto' }: { className?: string; title?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="250 250 745 745" role="img" aria-label={title} className={cn('size-7 shrink-0', className)} fill="currentColor">
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
