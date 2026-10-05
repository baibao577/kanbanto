import { File } from '@phosphor-icons/react'
import { Fragment, type ReactNode } from 'react'
import type { AttachmentView } from '@kanbanto/model/api'

/** A reference to a file in text: the paperclip and the file's name, e.g. "📎report.pdf". */
export const FILE_MARK = '📎'

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Comment or description text: @mentions highlighted, and "📎name" references to the card's files shown as chips
 * that open the file. A reference to a file that no longer exists stays as plain text.
 */
export function RichText({ text, mentions = [], files = [] }: { text: string; mentions?: { name: string }[]; files?: AttachmentView[] }) {
  const byName = new Map(files.map((f) => [f.name, f]))
  const tokens = [
    // Longest names first, so "@Ann Lee" wins over "@Ann", and "📎plan v2.pdf" over "📎plan".
    ...mentions.map((m) => `@${m.name}`).sort((a, b) => b.length - a.length),
    ...[...byName.keys()].sort((a, b) => b.length - a.length).map((n) => `${FILE_MARK}${n}`),
  ]
  if (!tokens.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${tokens.map(escape).join('|')})`, 'g'))
  const out: ReactNode[] = parts.map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
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
