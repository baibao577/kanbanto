import { Info, Lightbulb, Star, Warning, WarningOctagon, type Icon } from '@phosphor-icons/react'
import type { Token, Tokens } from 'marked'

// Callouts: a boxed part of a text that says what kind of thing it is (a note, a tip, a warning).
//
// In the Markdown a callout is a quote whose first line is a mark, the way GitHub writes its alerts:
//
//   > [!WARNING]
//   > Switch the power off at the board first.
//
// so it reads as a quote anywhere that doesn't know callouts, and assistants already write it. The five kinds are
// GitHub's. The kind's name is shown by the stylesheet (`data-label`), not written into the page: the text shown
// holds the letters of the text saved, as everywhere (see caret.ts and passages.ts).

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

export const CALLOUTS: Record<CalloutKind, { label: string; icon: Icon; words: string }> = {
  note: { label: 'Note', icon: Info, words: 'callout info box' },
  tip: { label: 'Tip', icon: Lightbulb, words: 'callout hint advice box' },
  important: { label: 'Important', icon: Star, words: 'callout key box' },
  warning: { label: 'Warning', icon: Warning, words: 'callout careful attention box' },
  caution: { label: 'Caution', icon: WarningOctagon, words: 'callout danger risk box' },
}

export const isCalloutKind = (s: unknown): s is CalloutKind => typeof s === 'string' && (CALLOUT_KINDS as readonly string[]).includes(s)

/**
 * A callout's mark, alone on the first line of a quote. With or without the backslashes an editor that doesn't know
 * callouts puts before the brackets when it saves one ("\[!NOTE\]"): such a callout still shows as one here, and is
 * written back clean the next time it is edited.
 */
const MARK = /^\\?\[!(note|tip|important|warning|caution)\\?\][ \t]*(?:\r?\n|$)/i

/** `tokens` without their first `n` characters as written (`raw`). Null: something other than text is cut in two. */
function dropStart(tokens: Token[], n: number): Token[] | null {
  const out: Token[] = []
  let left = n
  for (const t of tokens) {
    if (left <= 0) {
      out.push(t)
      continue
    }
    if (t.raw.length <= left) {
      left -= t.raw.length
      continue
    }
    if (t.type !== 'text' || !('text' in t) || t.text.slice(0, left) !== t.raw.slice(0, left)) return null
    out.push({ type: 'text', raw: t.raw.slice(left), text: t.text.slice(left) } as Tokens.Text)
    left = 0
  }
  return out
}

/**
 * The callout a quote is, when its first line is a callout's mark: its kind, and what is in it (the quote's
 * content without the mark). Null: an ordinary quote. Given marked's token for the quote, whichever way it was
 * lexed: the reader and the editor both ask here, so they agree on what is a callout.
 */
export function calloutOf(quote: Token): { kind: CalloutKind; tokens: Token[] } | null {
  const inside = (quote as Tokens.Blockquote).tokens ?? []
  const first = inside[0] as Tokens.Paragraph | undefined
  if (quote.type !== 'blockquote' || first?.type !== 'paragraph') return null
  const m = MARK.exec(first.raw)
  if (!m) return null
  const kind = m[1].toLowerCase() as CalloutKind
  let rest = inside.slice(1)
  // (The mark alone in its paragraph: the paragraph goes, with the blank line after it.)
  if (!first.raw.slice(m[0].length).trim()) {
    if (rest[0]?.type === 'space') rest = rest.slice(1)
    return { kind, tokens: rest }
  }
  const tokens = dropStart(first.tokens ?? [], m[0].length)
  if (!tokens) return null
  const paragraph = { ...first, raw: first.raw.slice(m[0].length), text: first.text.slice(m[0].length), tokens } as Tokens.Paragraph
  return { kind, tokens: [paragraph, ...rest] }
}
