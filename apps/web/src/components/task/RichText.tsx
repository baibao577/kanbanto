import { File } from '@phosphor-icons/react'
import { Fragment, type ReactNode } from 'react'
import type { AttachmentView } from '@kanbanto/model/api'
import type { CardRefs } from '@/app/card-refs'
import { hrefFor } from '@/app/router'

/** A reference to a file in text: the paperclip and the file's name, e.g. "📎report.pdf". */
export const FILE_MARK = '📎'

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A card's name as it's written: the letters of a board, a dash, its number. */
const NAME = /^([A-Z][A-Z0-9]{1,4})-([1-9]\d{0,8})$/

/**
 * Comment or description text: @mentions highlighted, and "📎name" references to the card's files shown as chips
 * that open the file. A reference to a file that no longer exists stays as plain text.
 *
 * `cards`: a card's name in the text (WEB-12) is a link to the card, when its letters are a board's the reader can
 * open (so "UTF-8" stays text). It shows exactly as written, and nothing is looked up to show it: a card of this
 * board opens in place; any other is found when the link is followed (see App: `?n=`).
 */
export function RichText({
  text,
  mentions = [],
  files = [],
  cards,
}: {
  text: string
  mentions?: { name: string }[]
  files?: AttachmentView[]
  cards?: CardRefs
}) {
  const byName = new Map(files.map((f) => [f.name, f]))
  const tokens = [
    // Longest names first, so "@Ann Lee" wins over "@Ann", and "📎plan v2.pdf" over "📎plan".
    ...mentions.map((m) => `@${m.name}`).sort((a, b) => b.length - a.length),
    ...[...byName.keys()].sort((a, b) => b.length - a.length).map((n) => `${FILE_MARK}${n}`),
  ].map(escape)
  // (A name stands alone: not the end of a longer word, nor the start of one.)
  if (cards?.boards.size) tokens.push(`(?<![A-Za-z0-9_-])(?:${[...cards.boards.keys()].map(escape).join('|')})-[1-9]\\d{0,8}(?![A-Za-z0-9_-])`)
  if (!tokens.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${tokens.join('|')})`, 'g'))
  const out: ReactNode[] = parts.map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
    const name = cards && !part.startsWith('@') && !part.startsWith(FILE_MARK) ? part.match(NAME) : null
    if (name && cards) {
      const boardId = cards.boards.get(name[1])!
      const card = boardId === cards.here ? cards.card(Number(name[2])) : undefined
      return (
        <a
          key={i}
          href={hrefFor({ page: 'board', id: boardId, ...(card ? { task: card.id } : { n: name[2] }) })}
          title={card?.title ?? 'Open this card'}
          onClick={(e) => {
            e.stopPropagation()
            // (With a key held, or the middle button, it's the browser's: a new tab, a new window.)
            if (!card || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
            e.preventDefault()
            cards.open(card.id)
          }}
          className="rounded bg-primary/10 px-1 font-mono text-[0.92em] font-medium whitespace-nowrap text-primary no-underline hover:bg-primary/20"
        >
          {part}
        </a>
      )
    }
    if (part.startsWith('@'))
      return (
        <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
          {part}
        </span>
      )
    const f = byName.get(part.slice(FILE_MARK.length))!
    return (
      <a
        key={i}
        href={f.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 align-baseline text-[0.92em] font-medium text-primary hover:bg-accent"
        title={`Open ${f.name}`}
      >
        <File className="size-3.5 shrink-0" />
        <span className="truncate">{f.name}</span>
      </a>
    )
  })
  return <>{out}</>
}
