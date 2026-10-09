import type { Token, Tokens } from 'marked'
import { Fragment, useMemo, type ReactNode } from 'react'
import type { AttachmentView } from '@kanbanto/model/api'
import type { CardRefs } from '@/app/card-refs'
import { RichText } from '@/components/task/RichText'
import { cn } from '@/lib/utils'
import { CALLOUTS, calloutOf } from './callouts'
import { isBreak, lex, picturesNamed } from './mdText'

export interface MarkdownProps {
  text: string
  /** The card's files, for "📎name" references. */
  files?: AttachmentView[]
  /** People mentioned, highlighted where their "@Name" appears. */
  mentions?: { name: string }[]
  /** Cards' names in the text (WEB-12) become links (see RichText). Not inside code, nor inside another link. */
  cards?: CardRefs
  /** Makes checklist items tickable: called with the item's number, in order (see toggleTask). */
  onToggleTask?: (n: number) => void
  /** Gives headings ids (h-0, h-1…), for a table of contents. */
  headingIds?: boolean
  /**
   * A picture among the card's files is shown where the text names it by itself on a line ("📎plan.png"): a
   * description's way of having pictures in it. Named in the middle of a sentence it stays the small link it is.
   */
  pictures?: boolean
  className?: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e])

/** Only links that can't run code. */
const safeHref = (href: string) => (/^(https?:|mailto:|\/|#)/i.test(href.trim()) ? href : null)

/**
 * Markdown, shown safely: built as React elements from marked's tokens, so HTML in the text is shown as text, never
 * run (but for a line break written as "<br>", which is shown as one). "📎name" file references and @mentions work
 * anywhere in the text.
 */
export function Markdown({ text, files, mentions, cards, onToggleTask, headingIds, pictures, className }: MarkdownProps) {
  const tokens = useMemo(() => lex(text), [text])
  let task = 0
  let heading = 0
  const shown = useMemo(() => new Map(pictures ? files?.flatMap((f) => (f.image ? [[f.name, f] as const] : [])) : []), [pictures, files])

  // (`linked`: inside a link, where a card's name is the link's own words and not a second link.)
  const inline = (ts: Token[] | undefined, key = '', linked = false): ReactNode =>
    ts?.map((t, i) => {
      const k = `${key}${i}`
      switch (t.type) {
        case 'strong':
          return <strong key={k}>{inline(t.tokens, k, linked)}</strong>
        case 'em':
          return <em key={k}>{inline(t.tokens, k, linked)}</em>
        case 'del':
          return <del key={k}>{inline(t.tokens, k, linked)}</del>
        case 'codespan':
          return <code key={k}>{decode(t.text)}</code>
        case 'br':
          return <br key={k} />
        case 'link': {
          const href = safeHref(t.href)
          return href ? (
            <a key={k} href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
              {inline(t.tokens, k, true)}
            </a>
          ) : (
            <Fragment key={k}>{inline(t.tokens, k, linked)}</Fragment>
          )
        }
        case 'image':
          // Pictures from elsewhere aren't loaded (they'd tell that site who's reading): a link instead.
          return safeHref(t.href) ? (
            <a key={k} href={t.href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
              {t.text || t.href}
            </a>
          ) : (
            <Fragment key={k}>{t.text}</Fragment>
          )
        case 'text':
          return 'tokens' in t && t.tokens?.length ? (
            <Fragment key={k}>{inline(t.tokens, k, linked)}</Fragment>
          ) : (
            <RichText key={k} text={decode(t.text)} files={files} mentions={mentions} cards={linked ? undefined : cards} />
          )
        case 'escape':
          return <Fragment key={k}>{decode(t.text)}</Fragment>
        case 'checkbox':
          // A checklist item's box (shown by the list, not here).
          return null
        case 'html':
          // A line break (how a table's cell has two lines); any other HTML: as the text it is.
          return isBreak(t.raw) ? <br key={k} /> : <Fragment key={k}>{t.raw}</Fragment>
        default:
          // Anything unknown: as the text it is.
          return <Fragment key={k}>{'raw' in t ? t.raw : ''}</Fragment>
      }
    })

  const block = (ts: Token[], key = ''): ReactNode =>
    ts.map((t, i) => {
      const k = `${key}${i}`
      switch (t.type) {
        case 'space':
          return null
        case 'heading': {
          const H = `h${Math.min(t.depth + 1, 6)}` as 'h2'
          return (
            <H key={k} id={headingIds && !key ? `h-${heading++}` : undefined}>
              {inline(t.tokens, k)}
            </H>
          )
        }
        case 'paragraph': {
          // A line that is only a picture's name (or a few such lines) is the picture.
          const named = shown.size ? picturesNamed(decode(t.text), shown) : null
          if (named)
            return (
              <Fragment key={k}>
                {named.map((f, j) => (
                  <Picture key={j} file={f} />
                ))}
              </Fragment>
            )
          return <p key={k}>{inline(t.tokens, k)}</p>
        }
        case 'text':
          return (
            <Fragment key={k}>
              {t.tokens ? inline(t.tokens, k) : <RichText text={decode(t.text)} files={files} mentions={mentions} cards={cards} />}
            </Fragment>
          )
        case 'code':
          return (
            <pre key={k}>
              <code>{t.text}</code>
            </pre>
          )
        case 'blockquote': {
          // A quote that starts with a callout's mark ("[!NOTE]") is a callout: a box of that kind.
          const box = calloutOf(t)
          if (!box) return <blockquote key={k}>{block(t.tokens ?? [], k)}</blockquote>
          const { icon: Mark, label } = CALLOUTS[box.kind]
          return (
            <div key={k} className="md-callout" data-callout={box.kind}>
              <span className="md-callout-icon" aria-hidden>
                <Mark weight="fill" />
              </span>
              {/* (The kind's name is shown by the stylesheet: the page holds the text's own letters only.) */}
              <div className="md-callout-body" data-label={label}>
                {block(box.tokens, k)}
              </div>
            </div>
          )
        }
        case 'hr':
          return <hr key={k} />
        case 'list': {
          const L = t.ordered ? 'ol' : 'ul'
          const tasks = (t.items as Tokens.ListItem[]).some((it) => it.task)
          return (
            <L key={k} start={t.ordered && t.start !== 1 ? Number(t.start) : undefined} data-tasks={tasks || undefined}>
              {(t.items as Tokens.ListItem[]).map((it, j) => {
                if (!it.task) return <li key={j}>{block(it.tokens, `${k}.${j}.`)}</li>
                const n = task++
                return (
                  <li key={j} data-task={it.checked ? 'done' : 'open'}>
                    <input
                      type="checkbox"
                      checked={!!it.checked}
                      disabled={!onToggleTask}
                      aria-label={it.checked ? 'Done' : 'Not done'}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleTask?.(n)}
                    />
                    {/* (The checkbox token itself is the first thing marked puts in the item.) */}
                    <div>
                      {block(
                        it.tokens.filter((x) => x.type !== 'checkbox'),
                        `${k}.${j}.`,
                      )}
                    </div>
                  </li>
                )
              })}
            </L>
          )
        }
        case 'table':
          return (
            <div key={k} className="md-table">
              <table>
                <thead>
                  <tr>
                    {t.header.map((c: Tokens.TableCell, j: number) => (
                      <th key={j} style={{ textAlign: t.align[j] ?? undefined }}>
                        {inline(c.tokens, `${k}h${j}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row: Tokens.TableCell[], r: number) => (
                    <tr key={r}>
                      {row.map((c, j) => (
                        <td key={j} style={{ textAlign: t.align[j] ?? undefined }}>
                          {inline(c.tokens, `${k}r${r}c${j}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        case 'html':
          return isBreak(t.raw) ? <br key={k} /> : <p key={k}>{t.raw}</p>
        default:
          return null
      }
    })

  return <div className={cn('md', className)}>{block(tokens)}</div>
}

/**
 * A picture in the text: the file itself, as wide as the text at most, and a link to it at its full size. Its name
 * is still there for a screen reader, and so that the shown text holds the same characters as the written text (a
 * click on a word further down finds that word in the editor: see caret.ts).
 */
function Picture({ file }: { file: AttachmentView }) {
  return (
    <figure className="md-picture">
      <a href={file.url} target="_blank" rel="noreferrer" title={`Open ${file.name}`} onClick={(e) => e.stopPropagation()}>
        <img src={file.url} alt="" loading="lazy" decoding="async" draggable={false} />
        <span className="sr-only">{file.name}</span>
      </a>
    </figure>
  )
}
